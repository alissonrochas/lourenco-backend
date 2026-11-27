import AuthLayout from '~/layouts/auth'
import { Link } from '@adonisjs/inertia/react'

/** Legacy page stays compiled, but public account creation has no registered route. */
export default function Signup() {
  return (
    <>
      <h1 className="auth__title">Cadastro indisponível</h1>
      <p className="auth__sub">O cadastro público de contas não está disponível.</p>
      <p className="auth__foot">
        <Link route="session.create" className="il">
          Acessar a gestão
        </Link>
      </p>
    </>
  )
}

Signup.layout = [AuthLayout]
