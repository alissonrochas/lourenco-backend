import assert from 'node:assert/strict'
import { DateTime } from 'luxon'
import { test } from '@japa/runner'
import {
  calculateBookingAvailability,
  InvalidAvailabilityInputError,
  localWeekday,
  type AvailabilityRules,
} from '#services/booking_availability_engine'

const date = '2026-12-25'
const now = DateTime.fromISO('2026-01-01T00:00:00Z')
function rules(overrides: Partial<AvailabilityRules> = {}): AvailabilityRules {
  return {
    weekly: { isActive: true, opensAtMinute: 540, closesAtMinute: 1080 },
    breaks: [],
    weeklySlotBlocks: [],
    dateBlocked: false,
    dateSlotBlocks: [],
    ...overrides,
  }
}
const starts = (input = rules(), localDate = date, reference = now) =>
  calculateBookingAvailability(localDate, input, reference).slots.map((slot) => slot.startsAtMinute)

test.group('pure booking availability engine', () => {
  test('rejects impossible dates, noncanonical strings and invalid reference instants', () => {
    for (const localDate of [
      '2026-02-29',
      '1900-02-29',
      '2028-02-30',
      '2026-04-31',
      '2026-13-01',
      '0000-01-01',
      '2026-1-01',
      '2026-12-25T00:00:00Z',
      `${date}\n`,
    ])
      assert.throws(
        () => calculateBookingAvailability(localDate, rules(), now),
        InvalidAvailabilityInputError
      )
    assert.throws(
      () => calculateBookingAvailability(date, rules(), DateTime.invalid('invalid test instant')),
      InvalidAvailabilityInputError
    )
  })

  test('identifies all ISO weekdays without relying on local midnight existing', () => {
    for (const [localDate, weekday] of [
      ['2026-12-21', 1],
      ['2026-12-22', 2],
      ['2026-12-23', 3],
      ['2026-12-24', 4],
      ['2026-12-25', 5],
      ['2026-12-26', 6],
      ['2026-12-27', 7],
      ['2018-11-04', 7],
    ] as const)
      assert.equal(localWeekday(localDate), weekday)
  })

  test('missing, inactive, unconfigured or malformed opening hours yield no slots', () => {
    for (const weekly of [
      null,
      { isActive: false, opensAtMinute: 540, closesAtMinute: 1080 },
      { isActive: true, opensAtMinute: null, closesAtMinute: null },
      { isActive: true, opensAtMinute: 541, closesAtMinute: 1080 },
      { isActive: true, opensAtMinute: 1080, closesAtMinute: 540 },
    ])
      assert.deepEqual(starts(rules({ weekly })), [])
  })

  test('generates one or multiple complete hour blocks with correct opening and exclusive closing', () => {
    assert.deepEqual(
      starts(rules({ weekly: { isActive: true, opensAtMinute: 540, closesAtMinute: 600 } })),
      [540]
    )
    assert.deepEqual(starts(), [540, 600, 660, 720, 780, 840, 900, 960, 1020])
    assert.deepEqual(
      starts(rules({ weekly: { isActive: true, opensAtMinute: 1380, closesAtMinute: 1440 } })),
      [1380]
    )
  })

  test('any intersection with an active break excludes the entire slot; touching boundaries do not', () => {
    assert.deepEqual(
      starts(rules({ breaks: [{ startsAtMinute: 720, endsAtMinute: 780, isActive: true }] })),
      [540, 600, 660, 780, 840, 900, 960, 1020]
    )
    assert.deepEqual(
      starts(rules({ breaks: [{ startsAtMinute: 735, endsAtMinute: 750, isActive: true }] })),
      [540, 600, 660, 780, 840, 900, 960, 1020]
    )
    assert.deepEqual(
      starts(rules({ breaks: [{ startsAtMinute: 540, endsAtMinute: 1080, isActive: false }] })),
      starts()
    )
  })

  test('active weekly slots are excluded and released ones do not override breaks', () => {
    const input = rules({
      weeklySlotBlocks: [
        { startsAtMinute: 600, isBlocked: true },
        { startsAtMinute: 720, isBlocked: false },
      ],
      breaks: [{ startsAtMinute: 720, endsAtMinute: 780, isActive: true }],
    })
    assert.deepEqual(starts(input), [540, 660, 780, 840, 900, 960, 1020])
  })

  test('a whole-date block dominates released date slots; a released date does not undo weekly blocks', () => {
    assert.deepEqual(
      starts(
        rules({ dateBlocked: true, dateSlotBlocks: [{ startsAtMinute: 600, isBlocked: false }] })
      ),
      []
    )
    assert.deepEqual(
      starts(
        rules({ dateBlocked: false, weeklySlotBlocks: [{ startsAtMinute: 600, isBlocked: true }] })
      ),
      [540, 660, 720, 780, 840, 900, 960, 1020]
    )
  })

  test('specific date blocks exclude only their active starts', () => {
    assert.deepEqual(
      starts(
        rules({
          dateSlotBlocks: [
            { startsAtMinute: 900, isBlocked: true },
            { startsAtMinute: 960, isBlocked: false },
          ],
        })
      ),
      [540, 600, 660, 720, 780, 840, 960, 1020]
    )
  })

  test('combines all blockers to produce the approved illustrative result in chronological order', () => {
    const input = rules({
      breaks: [{ startsAtMinute: 720, endsAtMinute: 780, isActive: true }],
      weeklySlotBlocks: [{ startsAtMinute: 600, isBlocked: true }],
      dateSlotBlocks: [{ startsAtMinute: 900, isBlocked: true }],
    })
    assert.deepEqual(starts(input), [540, 660, 780, 840, 960, 1020])
    const result = calculateBookingAvailability(date, input, now)
    const instants = result.slots.map((slot) => DateTime.fromISO(slot.startsAtUtc).toMillis())
    assert.deepEqual(
      instants,
      [...instants].sort((a, b) => a - b)
    )
  })

  test('released flags never open a closed day or create a slot beyond opening hours', () => {
    const released = [
      { startsAtMinute: 480, isBlocked: false },
      { startsAtMinute: 1080, isBlocked: false },
    ]
    assert.deepEqual(
      starts(
        rules({
          weekly: { isActive: false, opensAtMinute: 540, closesAtMinute: 1080 },
          dateSlotBlocks: released,
        })
      ),
      []
    )
    assert.deepEqual(starts(rules({ dateSlotBlocks: released })), starts())
  })

  test('past days and started slots are excluded and starts must be strictly future', () => {
    assert.deepEqual(starts(rules(), date, DateTime.fromISO('2026-12-26T00:00:00Z')), [])
    assert.deepEqual(
      starts(rules(), date, DateTime.fromISO('2026-12-25T12:00:00Z')),
      [600, 660, 720, 780, 840, 900, 960, 1020]
    )
    assert.deepEqual(
      starts(rules(), date, DateTime.fromISO('2026-12-25T12:30:00Z')),
      [600, 660, 720, 780, 840, 900, 960, 1020]
    )
    assert.deepEqual(starts(rules(), date, DateTime.fromISO('2026-12-25T11:59:59.999Z')), starts())
    assert.deepEqual(starts(rules(), date, DateTime.fromISO('2026-12-25T21:00:00Z')), [])
  })

  test('result exposes local wall times, UTC instants and actual offsets without service duration', () => {
    const result = calculateBookingAvailability(date, rules(), now)
    assert.equal(result.timezone, 'America/Sao_Paulo')
    assert.equal(result.slotDurationMinutes, 60)
    assert.deepEqual(result.slots[0], {
      localDate: date,
      startsAtMinute: 540,
      endsAtMinute: 600,
      startsAtLocal: '2026-12-25T09:00:00.000',
      endsAtLocal: '2026-12-25T10:00:00.000',
      startsAtUtc: '2026-12-25T12:00:00.000Z',
      endsAtUtc: '2026-12-25T13:00:00.000Z',
      startOffsetMinutes: -180,
      endOffsetMinutes: -180,
    })
    for (const slot of result.slots)
      assert.equal(
        DateTime.fromISO(slot.endsAtUtc).toMillis() - DateTime.fromISO(slot.startsAtUtc).toMillis(),
        3600000
      )
  })

  test('closing 24:00 advances the local end date across month, year and leap-day boundaries', () => {
    const input = rules({ weekly: { isActive: true, opensAtMinute: 1380, closesAtMinute: 1440 } })
    for (const [localDate, nextDate] of [
      ['2026-12-31', '2027-01-01'],
      ['2028-02-29', '2028-03-01'],
      ['2028-02-28', '2028-02-29'],
      ['2026-04-30', '2026-05-01'],
    ]) {
      const result = calculateBookingAvailability(
        localDate,
        input,
        DateTime.fromISO('2026-01-01T00:00:00Z')
      )
      assert.equal(result.slots[0].endsAtLocal, `${nextDate}T00:00:00.000`)
      assert.equal(result.slots[0].localDate, localDate)
    }
  })

  test('spring DST excludes nonexistent midnight rather than shifting it to 01:00', () => {
    const result = calculateBookingAvailability(
      '2018-11-04',
      rules({ weekly: { isActive: true, opensAtMinute: 0, closesAtMinute: 180 } }),
      DateTime.fromISO('2018-01-01T00:00:00Z')
    )
    assert.deepEqual(
      result.slots.map((slot) => slot.startsAtMinute),
      [60, 120]
    )
    assert.equal(result.slots[0].startOffsetMinutes, -120)
    assert.equal(result.slots[0].startsAtUtc, '2018-11-04T03:00:00.000Z')
  })

  test('fall DST excludes both ambiguous boundaries and slots adjacent to them', () => {
    const result = calculateBookingAvailability(
      '2019-02-16',
      rules({ weekly: { isActive: true, opensAtMinute: 1260, closesAtMinute: 1440 } }),
      DateTime.fromISO('2019-01-01T00:00:00Z')
    )
    assert.deepEqual(
      result.slots.map((slot) => slot.startsAtMinute),
      [1260]
    )
    const next = calculateBookingAvailability(
      '2019-02-17',
      rules({ weekly: { isActive: true, opensAtMinute: 0, closesAtMinute: 120 } }),
      DateTime.fromISO('2019-01-01T00:00:00Z')
    )
    assert.equal(next.slots[0].startOffsetMinutes, -180)
  })

  test('calendar calculations never mutate supplied rules or reference instant', () => {
    const input = rules({
      breaks: [
        { startsAtMinute: 780, endsAtMinute: 840, isActive: true },
        { startsAtMinute: 600, endsAtMinute: 660, isActive: false },
      ],
    })
    const before = JSON.stringify(input)
    const instant = now.toISO()
    calculateBookingAvailability(date, input, now)
    assert.equal(JSON.stringify(input), before)
    assert.equal(now.toISO(), instant)
  })
})
