# Revisões e concorrência do calendário — Etapa 8

A API já oferecia GET/PATCH `/api/admin/booking-settings` e GET/POST `/api/admin/calendar-exceptions`. Os contratos JSON, autenticação, CSRF, modelos, migrations e duração efetiva não mudam nesta etapa. Foi adicionada uma precondição otimista para evitar sobrescritas silenciosas pelo novo painel.

## ETag e If-Match

As leituras bem-sucedidas e respostas de escrita retornam `ETag`, uma revisão forte entre aspas com SHA-256 do snapshot persistido e do escopo. O token é opaco: o cliente deve copiar o valor integral, incluindo aspas, sem calculá-lo. Não contém dados pessoais ou motivos em texto aberto.

- Funcionamento semanal: uma revisão para o conjunto completo de settings/dias/filhos, lido em transação consistente. Alterações em outro dia também invalidam um editor anterior, conservadoramente.
- Exceções: revisão para o intervalo exato consultado. Para editar uma data, consultar `from=to=localDate` e enviar essa revisão. A revisão de um intervalo maior ou de outra data não serve para a escrita de uma data.
- O hash inclui a representação persistida e seus timestamps; mudanças de auditoria também podem invalidar uma revisão. Não é um relógio ou contador global.

```http
GET /api/admin/booking-settings
# 200, ETag: "<64 caracteres hexadecimais>"

PATCH /api/admin/booking-settings
Content-Type: application/json
X-XSRF-TOKEN: <token da sessão>
If-Match: "<revisão recebida>"

{"days":[{"weekday":1,"isActive":false}]}
```

Uma revisão desatualizada recebe **409 JSON/no-store**, com orientação para recarregar. Formato inválido, `*`, tags fracas e listas não são aceitos (422). A checagem ocorre depois da aquisição da trava de escrita do SQLite e antes de qualquer modificação de negócio, na mesma transação da proteção de reservas e gravação. Não há consulta prévia seguida de escrita fora da transação.

Para preservar clientes existentes, `If-Match` é opcional no contrato legado. O novo painel exige uma revisão válida para toda escrita. Clientes antigos que omitirem a precondição mantêm a semântica anterior e podem sobrescrever configurações: esta extensão não promete impedir alterações desatualizadas de escritores que optam por não enviar revisão. Tornar a precondição obrigatória para toda integração seria uma mudança de contrato separada.

CORS continua limitado às origens configuradas e com credenciais. Acrescenta somente `If-Match` aos headers permitidos e `ETag` aos expostos; não flexibiliza CSRF nem autenticação. Retry-After permanece com sua limitação anterior entre origens.

## Reservas e duração

A primeira operação de todas as transações de criação de reserva, alteração semanal, alteração excepcional e cancelamento continua sendo a escrita de trava em `booking_settings`. Proteção e atualização compartilham essa transação, inclusive com mais de uma conexão/processo SQLite. Ausência do singleton não elimina a trava. Não foram alterados motor, disponibilidade pública, tabelas ou schema.

Alterações incompatíveis com reservas confirmed ainda não encerradas, incluindo em andamento, continuam recusadas com 409 e rollback integral. Nenhum registro de reserva, snapshot, status ou auditoria é modificado automaticamente. Uma liberação não ignora expediente, almoço, bloqueios semanais, outras exceções ou ocupação.

O calendário aceita apenas horas cheias e blocos de 60 minutos; abertura 00:00–23:00, encerramento até 24:00, sem expediente atravessando a meia-noite. Intervalos ativos devem ficar dentro do expediente e não se sobrepor. Limites parciais como 10:30 são inválidos na configuração atual. O motor usa interseção de intervalos e exige que o bloco inteiro termine dentro do expediente; não foi introduzida duração variável por serviço.

## Validação isolada

- 100 testes unitários e 169 funcionais: **269 aprovados**, zero reprovados na execução final.
- Oito novos funcionais verificam estabilidade/leitura sem escrita, revisão semanal, escopo de data, três formatos inválidos, dois escritores HTTP com a mesma revisão e preflight CORS.
- Testes anteriores de conexões SQLite independentes, disputa reserva/calendário, proteção de reservas, autenticação e CSRF permanecem aprovados.
- Lint e build aprovados. Typecheck completo mantém os oito diagnósticos preexistentes do Inertia (marketing/signup; rotas new_account e campos antigos). Nenhum diagnóstico novo.

A suíte foi executada em cópia descartável com SQLite de teste, nunca no banco original. Os E2E do frontend dependente exercitam edição concorrente entre dois navegadores, conflitos reais, rollback, oferta pública e preservação integral das reservas. Não há dependência nova nem alteração de lockfile, ambientes ou banco de desenvolvimento.
