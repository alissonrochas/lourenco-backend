export function normalizePhone(phone: string) {
  return phone.replace(/\D/g, '')
}

export function isValidPhone(phone: string) {
  const normalized = normalizePhone(phone)
  return normalized.length >= 10 && normalized.length <= 15
}
