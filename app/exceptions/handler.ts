import { errors as vineErrors } from '@vinejs/vine'
import {
  isApiRequest,
  isPrivateResponse,
  noStore,
  internalServerError,
} from '#services/http_response_policy'
import { logHttpFailure, safeError } from '#services/safe_http_logging'
import app from '@adonisjs/core/services/app'
import { type HttpContext, ExceptionHandler } from '@adonisjs/core/http'
import type { StatusPageRange, StatusPageRenderer } from '@adonisjs/core/types/http'

export default class HttpExceptionHandler extends ExceptionHandler {
  /**
   * In debug mode, the exception handler will display verbose errors
   * with pretty printed stack traces.
   */
  protected debug = !app.inProduction

  /**
   * Status pages are used to display a custom HTML pages for certain error
   * codes. You might want to enable them in production only, but feel
   * free to enable them in development as well.
   */
  protected renderStatusPages = app.inProduction

  /**
   * Status pages is a collection of error code range and a callback
   * to return the HTML contents to send as a response.
   */
  protected statusPages: Record<StatusPageRange, StatusPageRenderer> = {
    '404': (_, { inertia }) => inertia.render('errors/not_found', {}),
    '500..599': (_, { inertia }) => inertia.render('errors/server_error', {}),
  }

  /**
   * The method is used for handling errors and returning
   * response to the client
   */
  async handle(error: unknown, ctx: HttpContext) {
    if (isPrivateResponse(ctx)) noStore(ctx)
    if (!isApiRequest(ctx)) return super.handle(error, ctx)
    noStore(ctx)
    if ((error as { code?: unknown })?.code === 'E_BAD_CSRF_TOKEN') {
      return ctx.response.forbidden({
        code: 'E_BAD_CSRF_TOKEN',
        message: 'Token CSRF inválido ou expirado.',
      })
    }
    // Handle Vine directly: its own handler negotiates HTML redirects/flash data.
    if (error instanceof vineErrors.E_VALIDATION_ERROR)
      return ctx.response.status(422).json({ errors: error.messages })
    const { status } = safeError(error)
    const responses: Record<number, { code: string; message: string }> = {
      400: { code: 'BAD_REQUEST', message: 'Solicitação inválida.' },
      401: { code: 'UNAUTHENTICATED', message: 'Não autenticado.' },
      403: { code: 'FORBIDDEN', message: 'Acesso não permitido.' },
      404: { code: 'NOT_FOUND', message: 'Recurso não encontrado.' },
      405: { code: 'METHOD_NOT_ALLOWED', message: 'Método não permitido.' },
      409: {
        code: 'CONFLICT',
        message: 'Não foi possível concluir a operação devido a um conflito.',
      },
      422: { code: 'UNPROCESSABLE_ENTITY', message: 'Dados inválidos.' },
      429: {
        code: 'TOO_MANY_REQUESTS',
        message: 'Muitas tentativas. Aguarde antes de tentar novamente.',
      },
      503: { code: 'SERVICE_UNAVAILABLE', message: 'Serviço temporariamente indisponível.' },
    }
    return ctx.response
      .status(status)
      .json(
        responses[status] ??
          (status >= 500
            ? internalServerError
            : { code: 'REQUEST_ERROR', message: 'Não foi possível processar a solicitação.' })
      )
  }

  /**
   * The method is used to report error to the logging service or
   * the a third party error monitoring service.
   *
   * @note You should not attempt to send a response from this method.
   */
  async report(error: unknown, ctx: HttpContext) {
    // Do not delegate to raw error serializers, messages or custom error.report().
    if (this.shouldReport(this.toHttpError(error))) logHttpFailure(ctx, error)
  }
}
