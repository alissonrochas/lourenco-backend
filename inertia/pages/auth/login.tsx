import AuthLayout from '~/layouts/auth'
import { Form } from '@adonisjs/inertia/react'

export default function Login() {
  return (
    <>
      <h1 className="auth__title">Acesso da gestão</h1>
      <p className="auth__sub">Entre para controlar horários, clientes e agenda.</p>

      <Form route="session.store">
        {({ errors, processing }) => (
          <div className="auth__form">
            <div className="field">
              <label className="field__label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                className="field__input"
                autoComplete="username"
                placeholder="you@example.com"
                aria-invalid={errors.email ? 'true' : 'false'}
              />
              {errors.email && <span className="field__error">{errors.email}</span>}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                className="field__input"
                autoComplete="current-password"
                placeholder="••••••••"
                aria-invalid={errors.password ? 'true' : 'false'}
              />
              {errors.password && <span className="field__error">{errors.password}</span>}
            </div>

            <button
              type="submit"
              className="btn btn--primary btn--block"
              disabled={processing}
              style={{ marginTop: 4 }}
            >
              {processing ? 'Aguarde…' : 'Entrar'}
            </button>
          </div>
        )}
      </Form>

      <p className="auth__foot">
        Acesso exclusivo da gestão.
      </p>
    </>
  )
}

Login.layout = [AuthLayout]
