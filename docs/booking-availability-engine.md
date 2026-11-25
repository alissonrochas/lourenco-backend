# Motor de disponibilidade da agenda

Esta etapa implementa somente cálculo e leitura de regras persistidas. Não cria rotas, migrations, tabelas, reservas ou frontend. Segue [booking-mvp-plan.md](booking-mvp-plan.md), [booking-schedule-model.md](booking-schedule-model.md), [admin-booking-settings-api.md](admin-booking-settings-api.md) e [admin-calendar-exceptions-api.md](admin-calendar-exceptions-api.md).

## Arquitetura

- `booking_availability_engine.ts`: função pura `calculateBookingAvailability`, tipos de entrada/saída, validação e resolução das fronteiras locais. Não acessa banco, HTTP, catálogo, relógio global ou dados pessoais.
- `booking_availability_service.ts`: `BookingAvailabilityService`, que consulta os models existentes numa transação e entrega as regras ao motor. Aceita uma transação externa para reutilização futura.
- Reutiliza `isLocalCalendarDate` e o ordinal gregoriano existentes para validar datas reais e identificar o dia ISO da semana, sem depender da existência da meia-noite naquele fuso.

Uma agenda para um barbeiro. `America/Sao_Paulo` e 60 minutos são regras fixas aprovadas, não horários de funcionamento inventados. Abertura, fechamento, pausas e bloqueios são lidos do banco; não há fallback para um expediente padrão. Nenhum cálculo é armazenado ou mantido em cache global mutável.

## Entrada

```ts
import { DateTime } from 'luxon'
import BookingAvailabilityService from '#services/booking_availability_service'

const engine = new BookingAvailabilityService()
const result = await engine.calculate('2026-12-25', {
  now: DateTime.fromISO('2026-12-01T12:00:00Z'),
})
```

```ts
type AvailabilityOptions = {
  now?: DateTime
  client?: TransactionClientContract
}
```

A data deve ser uma string canônica YYYY-MM-DD com dia real, ano 0001–9999 e validação de bissextos (incluindo séculos). Não há normalização silenciosa de data inválida nem parsing por `new Date("YYYY-MM-DD")`. O serviço de domínio não usa o body parser HTTP, portanto espaços/sufixos também são rejeitados.

`now` deve ser um DateTime válido e representa um instante, qualquer que seja seu offset. Ausência de now usa a função clock do construtor, cujo padrão captura `DateTime.utc()` uma vez por cálculo. Testes podem injetar essa função ou fornecer now. A função pura exige now explicitamente e não consulta o relógio.

Data inválida ou referência inválida produz `InvalidAvailabilityInputError`, antes de qualquer consulta. Não há serviceId, duração arbitrária, janela mínima de antecedência nem horizonte máximo de reserva. O catálogo não é consultado; a duração/ativação de um serviço não altera o resultado da agenda nesta etapa.

## Regras de cálculo

1. Validar data e referência e obter weekday ISO 1–7.
2. Carregar apenas o dia semanal correspondente. Dia ausente, inativo ou sem horários retorna slots vazio; configuração de abertura malformada também falha de forma fechada.
3. Gerar candidatos em horas cheias de abertura até fechamento, incluindo somente intervalos completos de 60 minutos. O fechamento é limite final, não início oferecido.
4. Remover qualquer candidato que intersecte uma pausa ativa: `início < fimDaPausa && fim > inícioDaPausa`. Tocar a fronteira sem interseção não bloqueia. Nunca retornar a parte restante de um bloco.
5. Remover inícios bloqueados semanalmente ou naquela data e descartar todos se a data inteira estiver bloqueada.
6. Resolver as fronteiras locais pelo fuso IANA e excluir blocos inseguros segundo a política abaixo.
7. Exigir instante inicial estritamente maior que now; ordenar por instante UTC crescente.

Qualquer impedimento ativo prevalece. Flags de liberação/inatividade apenas deixam de contribuir com um impedimento: não abrem um dia fechado, não ampliam abertura, não removem pausa e não anulam outro bloqueio. Bloqueio integral da data domina uma liberação de slot. Pausas/bloqueios inativos podem permanecer no armazenamento e são ignorados no cálculo.

A implementação não consulta reservas: não existe ocupação simulada ou garantia de exclusividade.

## Saída

```ts
type AvailabilityResult = {
  localDate: string
  weekday: number // ISO 1–7
  timezone: 'America/Sao_Paulo'
  slotDurationMinutes: 60
  slots: AvailabilitySlot[]
}

type AvailabilitySlot = {
  localDate: string
  startsAtMinute: number
  endsAtMinute: number
  startsAtLocal: string
  endsAtLocal: string
  startsAtUtc: string
  endsAtUtc: string
  startOffsetMinutes: number
  endOffsetMinutes: number
}
```

`startsAtLocal` e `endsAtLocal` são strings ISO de **horário de parede sem offset**. Devem ser interpretadas junto com timezone e os offsets numéricos; não são instantes UTC. Isso também evita arredondar offsets históricos que continham segundos. Os instantes inequívocos para integração são startsAtUtc e endsAtUtc, com Z. Offsets são os valores reais fornecidos pelo Luxon/Intl, em minutos, e não uma constante -180.

Exemplo ilustrativo para uma configuração persistida de 09:00–18:00, pausa 12:00–13:00, bloqueio semanal às 10:00 e excepcional às 15:00, antes do dia consultado:

```json
{
  "localDate": "2026-12-25",
  "weekday": 5,
  "timezone": "America/Sao_Paulo",
  "slotDurationMinutes": 60,
  "slots": [
    {
      "localDate": "2026-12-25",
      "startsAtMinute": 540,
      "endsAtMinute": 600,
      "startsAtLocal": "2026-12-25T09:00:00.000",
      "endsAtLocal": "2026-12-25T10:00:00.000",
      "startsAtUtc": "2026-12-25T12:00:00.000Z",
      "endsAtUtc": "2026-12-25T13:00:00.000Z",
      "startOffsetMinutes": -180,
      "endOffsetMinutes": -180
    }
  ]
}
```

O JSON mostra o formato do primeiro bloco; nesse cenário a lista completa tem inícios locais **09:00, 11:00, 13:00, 14:00, 16:00 e 17:00**. Nada desse exemplo é seed ou default do banco. Um dia fechado retorna os mesmos metadados e `slots: []`.

Fechamento em 1440 representa o término 24:00: o bloco de 23:00 termina às 00:00 da próxima data local, inclusive na virada de mês, ano ou dia bissexto. localDate continua sendo a data do início; endsAtLocal informa a próxima data. Fronteiras além do ano local suportado 9999 são descartadas por segurança.

## Fuso e transições

Luxon utiliza a base de fuso IANA disponível no runtime Node/Intl. Não se presume offset constante nem ausência permanente de horário de verão. Atualizações da base de fuso podem alterar previsões futuras; o cálculo é refeito a partir das regras persistidas e da base instalada.

Cada fronteira é construída explicitamente a partir de ano, mês, dia e hora em America/Sao_Paulo. Após a construção, o motor compara esses componentes para detectar a normalização que Luxon faria para um horário inexistente. `getPossibleOffsets()` detecta fronteiras ambíguas. A política conservadora é:

- Se o início **ou** o fim não existir ou admitir mais de um instante, descartar o candidato inteiro.
- Não escolher silenciosamente a primeira/segunda ocorrência de uma hora repetida.
- Exigir exatamente 3.600.000 ms entre início e fim; nenhuma disponibilidade parcial ou bloco com duração física diferente de 60 minutos.

Isso pode excluir também um bloco adjacente a uma fronteira ambígua/inexistente, mesmo quando uma interpretação seria possível. É uma escolha intencional de segurança para o MVP, não uma tentativa de oferecer todas as alternativas de transição.

Casos testados: 00:00 inexistente em 04/11/2018 (não vira automaticamente 01:00), 23:00 repetida em 16/02/2019 (as duas alternativas são descartadas) e retorno ao offset -180 no dia seguinte. O dia ISO é calculado no calendário, sem ser alterado por normalização de meia-noite.

Para avançar 24:00 à próxima data, usa-se UTC somente como calendário neutro de aritmética de componentes. Esse valor intermediário nunca é tratado como o instante do horário local; a fronteira real é reconstruída no fuso da barbearia.

## Política de passado

Oferecer apenas `inícioUTC > now`. Um bloco começando exatamente em now já não é oferecido. Um bloco que começou às 09:00 não aparece numa consulta às 09:30, mesmo que ainda não tenha terminado. Horários futuros do mesmo dia permanecem elegíveis. Dias passados resultam em lista vazia, após aplicar as mesmas comparações de instantes.

Não há arredondamento do relógio, bloqueio artificial de uma hora de antecedência ou limite de horizonte introduzido nesta etapa.

## Consultas e consistência

O serviço utiliza os models WeeklyOpeningHour, WeeklyBreak, WeeklySlotBlock, DateBlock e DateSlotBlock. Não lê usuários, clientes, sessões, catálogo, motivos administrativos ou dados de reservas. Seleciona somente os campos necessários às regras.

Por padrão, abre uma transação Lucid de leitura e executa todas as consultas naquele cliente: até cinco SELECTs por cálculo, independentemente da quantidade de blocos. Dias fechados/não configurados encerram cedo; data integralmente bloqueada dispensa consultas de detalhes. Não há N+1 nem leitura fora da transação. Não há escrita, inicialização de configuração, persistência de disponibilidade ou mutex em memória.

Para reutilizar uma transação existente:

```ts
const result = await engine.calculate(localDate, { now, client: trx })
```

O motor não abre uma transação aninhada, não faz commit e não faz rollback de trx. Enxerga suas alterações ainda não commitadas e respeita o snapshot já estabelecido pelo chamador. A consistência/isolamento da transação externa é responsabilidade da camada que a abriu; o caminho padrão usa o SQLite atual e seu snapshot transacional.

Os testes verificam a identidade transacional das consultas, ausência de comandos de escrita e preservação das tabelas/fixtures. Outro teste usa SQLite temporário em WAL: um leitor mantém seu snapshot enquanto outra conexão confirma mudanças no funcionamento e nas exceções, sem que o cálculo misture as versões.

## Integração futura com reservas e APIs

O resultado é somente elegibilidade do calendário no snapshot lido. Não reserva horário e **não impede duas reservas simultâneas**.

A futura camada de reservas deverá, depois de adquirir a trava de escrita prevista no plano, usar esse mesmo cliente transacional para recalcular regras, excluir reservas confirmadas e persistir a nova reserva com constraint de unicidade apropriada. O serviço marca o ponto de inclusão da ocupação; ainda não consulta tabelas inexistentes. Alterações administrativas também precisarão verificar conflitos com reservas dentro da estratégia transacional, sem cancelamento silencioso.

A futura API de reservas validará o serviço ativo e os dados de contato, mantendo clientes sem login. A duração do serviço não muda os blocos fixos deste MVP. A futura API pública deverá limitar consultas/serializar explicitamente o resultado e preservar privacidade; nenhuma nova rota, autenticação ou regra HTTP foi implementada aqui.

## Testes e execução

```bash
npm test -- unit
npm test -- functional
npm run lint
npm run build
```

Os testes puros injetam a referência temporal. Os testes de persistência usam o helper existente de SQLite temporário e migrations reais, nunca o banco de desenvolvimento. A suíte funcional anterior é executada integralmente como regressão; a validação desta etapa também roda numa cópia descartável do backend.

Cobertura: datas/ISO weekday, ausência/inatividade de configuração, um/múltiplos blocos, fronteiras, interseção de pausas, bloqueios e liberações, precedência, passado/mesmo dia, tipos de saída, UTC/offsets, mês/ano/bissexto, transições reais de fuso, imutabilidade, ausência de escrita, consultas limitadas, snapshot consistente e reutilização de transação externa. Sem dependências novas ou alterações nas migrations existentes.
