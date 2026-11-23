import env from '#start/env'
import { defineConfig } from '@adonisjs/cors'

const allowedOrigins = env
  .get('CORS_ALLOWED_ORIGINS')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

const corsConfig = defineConfig({
  enabled: true,
  origin: allowedOrigins,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH'],
  headers: ['Content-Type', 'X-XSRF-TOKEN', 'X-CSRF-TOKEN'],
  exposeHeaders: [],
  credentials: true,
  maxAge: 90,
})

export default corsConfig
