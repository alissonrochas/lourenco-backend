# Criação pública de reservas

`POST /api/bookings` confirma um bloco na agenda única, sem login de cliente. Reutiliza os models e a migration de reservas existentes; esta etapa não cria tabelas nem executa migrations no banco de desenvolvimento. Não há cancelamento, reagendamento, listagem ou consulta pública por ID/telefone.

## Contrato

Preparar CSRF com `GET /api/csrf`, manter cookies (`credentials: 'include'`) e enviar o token pelo header `X-XSRF-TOKEN`, conforme as escritas existentes. Content-Type deve ser `application/json`.

```json
{
  "serviceId": 1,
  "localDate": "2026-12-28",
  "startsAtMinute": 540,
  "name": "Cliente Exemplo",
  "phone": "(71) 99999-9999"
}
```

Exemplo de resposta **201**, `Cache-Control: no-store`:

```json
{
  "data": {
    "id": 123,
    "serviceName": "Corte",
    "priceCents": 4500,
    "localDate": "2026-12-28",
    "startsAtMinute": 540,
    "startsAtLocal": "2026-12-28T09:00:00.000-03:00",
    "endsAtLocal": "2026-12-28T10:00:00.000-03:00",
    "timezone": "America/Sao_Paulo",
    "slotDurationMinutes": 60,
    "status": "confirmed"
  }
}
```

O transformer permite somente essas propriedades. Nome/preço são os snapshots gravados; o horário local inclui offset e o fuso é explícito. Não retorna nome, telefone ou ID do cliente, normalização, sessão, IDs administrativos, timestamps de auditoria ou informações de outras reservas. O ID não autentica o cliente e não habilita consulta/cancelamento. Não existe endpoint de leitura de reservas nesta etapa.

## Validação e contato

VineJS valida exclusivamente o corpo, sem mesclar query/headers/params. Não aceita campos desconhecidos, IDs internos, preço, snapshots, status, duração ou dados de cancelamento. Números são JSON numbers inteiros, não strings, booleanos ou null.

- serviceId: inteiro positivo seguro; serviço precisa existir e estar ativo na transação de confirmação.
- localDate: data gregoriana real e canônica YYYY-MM-DD, anos 0001–9999, incluindo bissextos. O body parser original normaliza espaços externos; depois disso a data deve ser canônica. Não usar `new Date('YYYY-MM-DD')`.
- startsAtMinute: 0–1380, múltiplo de 60. O bloco inteiro precisa ser elegível no motor e ter início estritamente futuro.
- name: trim, 2–120 caracteres, mesmas regras do cadastro de clientes.
- phone: string de 8–30 caracteres com dígitos, espaços, parênteses, `+` ou `-`. Reutiliza `isValidPhone`/`normalizePhone`: resultado com 10–15 dígitos, sem introduzir suposição de DDI ou outro normalizador.

O body parser instalado usa `safeParse` e não oferece diagnóstico confiável de chaves JSON repetidas: o último valor prevalece antes da validação. Não se adicionou parser artesanal nem regex de JSON. A whitelist e validações aplicam-se ao objeto resultante; clientes devem enviar cada chave uma única vez. JSON sintaticamente inválido e limites de tamanho permanecem sob os handlers originais do body parser.

A resolução busca primeiro phoneNormalized, depois o telefone exato canônico para respeitar o índice original em registros legados com normalização null. Sem correspondência, cria Customer com telefone canônico. Nunca sobrescreve nome/telefone de um cliente existente, promove registros legados, varre/funde telefones ambíguos nem informa se um cadastro foi criado. Duplicados legados permanecem preservados, conforme a política existente. Uma linha legada apenas formatada e com normalização null não é automaticamente conciliada; saneamento de legado exige revisão separada.

Telefone é contato, **não prova de identidade**. O MVP não comprova posse do telefone; alguém pode fornecer contato de terceiro. Essa limitação não autoriza leitura ou alteração do cadastro existente.

## Transação e concorrência SQLite

BookingCreationService abre uma única transação Lucid. A primeira instrução é `UPDATE booking_settings SET id = 1 WHERE id = 1`, também eficaz com a tabela vazia: adquire a trava SQLite de escrita antes das leituras decisivas, sem inicializar configuração ou mudar timestamps. É a mesma estratégia utilizada pelos escritores administrativos, comprovada com duas conexões independentes.

Sob essa trava:

1. Resolve/cria o cliente pelo telefone normalizado.
2. Consulta o serviço ativo e captura nome/preço atuais.
3. Captura o relógio do servidor após a aquisição da trava.
4. Chama BookingAvailabilityService com esse cliente transacional e instante. Calendário e reservas confirmed são consultados no mesmo snapshot.
5. Exige que o início solicitado esteja nos slots restantes.
6. Converte os instantes ISO UTC calculados pelo motor para Unix milliseconds e cria Booking com atribuição explícita de campos, status confirmed e snapshots.
7. Faz commit. Falha em qualquer passo reverte inclusive um cliente recém-criado.

Cada bloco ocupa 60 minutos, independentemente de Service.durationMinutes. A resolução IANA e a rejeição de horários inexistentes/ambíguos permanecem no motor puro e no hook do model. O índice parcial `bookings_confirmed_start_unique` continua como última barreira, inclusive se um adapter defeituoso devolver disponibilidade desatualizada. Reservas cancelled não ocupam esse índice.

Escritores em conexões/processos distintos ao mesmo SQLite se serializam pela trava do banco. Não há mutex em memória nem verificação de vaga fora da transação seguida de inserção desprotegida. Sob contenção, o driver pode aguardar seu timeout ou retornar erro; não existe retry automático. Após commit concorrente, a próxima transação recalcula e recebe 409 se a vaga estiver ocupada.

### Proteção das reservas ao editar calendário

BookingSettingsService e CalendarExceptionsService mantêm a trava como primeira instrução e verificam conflitos antes de salvar mudanças. Reservas confirmed com `endsAtUtc > now` são protegidas, incluindo um bloco já iniciado. Reservas encerradas e cancelled não impedem alterações.

- Exceções recusam bloquear a data inteira ou os horários de reservas protegidas. Liberações e horários não afetados continuam permitidos.
- Funcionamento semanal valida a configuração resultante e usa o motor puro para verificar que cada reserva protegida daquele weekday continua cabendo, sem pausa ou bloqueio recorrente. Não conta a própria ocupação como impedimento.
- Qualquer conflito recebe 409 JSON/no-store com mensagem administrativa genérica. Reverte todo o payload, inclusive dias/itens anteriores e inicialização do singleton. Não cancela, move ou exclui reservas.

Sem operação de cancelamento nesta etapa, conflitos precisam aguardar a futura gestão administrativa auditada; não usar SQL manual como fluxo de produto. Mudanças de serviço preservam snapshots das reservas anteriores.

## Disponibilidade com ocupação

`GET /api/availability?date=YYYY-MM-DD` preserva o contrato anterior. BookingAvailabilityService calcula o calendário pelo motor puro e consulta somente startsAtUtc de reservas confirmed nos inícios candidatos (no máximo 24), usando a mesma transação. Remove esses inícios sem carregar contato, motivos ou auditoria. Não há uma consulta por slot; o máximo passa de cinco para seis SELECTs. Dias fechados ou sem candidatos encerram cedo.

Reservas cancelled não removem slots. Cancelar diretamente nos testes verifica persistência, não cria uma API de cancelamento. A consulta continua informativa: outra confirmação pode ocorrer entre GET e POST; o cliente precisa tratar 409 e recarregar a lista.

A identidade exata da exceção stateless permanece GET + nome de rota + padrão `/api/availability`. A adição de ocupação não inicializa/persiste sessão nem envia Set-Cookie. Os testes instrumentam o store com persistência real na tabela sessions, inclusive após uma reserva real.

## Segurança e limites de abuso

O código instalado do Adonis atribui ctx.route antes do pipeline de roteador. Foram preservados wrappers, ordem e middlewares originais. O POST não recebe a exceção stateless; mantém sessão, Shield/CSRF, inicialização de auth e silent auth originais, seguidos do limitador específico da rota. Não requer papel administrativo para criar a própria reserva pública. As APIs administrativas continuam com adminAuth e verificação do papel atual.

O orçamento de criação é **10 tentativas por IP por janela de 60 segundos**, namespace booking-ip, independente de availability-ip (60/min), cadastro e login. Tentativas válidas, inválidas e conflitantes que alcançam a rota consomem orçamento. Body parser e CSRF executam antes; rejeições nessas camadas seguem os limites/handlers existentes e não consomem esse contador. Não se enfraqueceu CSRF para antecipar o limitador.

Usa somente `request.ip()`, com TRUST_PROXY configurado para proxies conhecidos; não confia diretamente em X-Forwarded-For ou X-Real-IP. Preserva headers de segurança do Shield. O limite é por processo, reinicia com ele e não se compartilha entre instâncias; NAT pode compartilhar orçamento, IPs distribuídos contornam o limite e o Map existente não expurga IPs ociosos. Proteção de borda/armazenamento compartilhado e verificação de contato são evoluções separadas.

Erros inesperados de criação geram log genérico sem registrar o erro do driver, SQL/bindings, nome ou telefone. Respostas não publicam stack ou detalhes internos.

## Erros

| HTTP | Situação |
| --- | --- |
| 201 | Reserva confirmada, envelope data |
| 422 | Entrada inválida ou serviço ausente/inativo: `Dados inválidos ou serviço indisponível.`; Content-Type diferente de JSON recebe orientação genérica |
| 403 | CSRF ausente/inválido, handler original preservado |
| 409 | Slot indisponível ou SQLITE_CONSTRAINT_UNIQUE: `Horário indisponível. Consulte os horários novamente.` |
| 429 | Orçamento esgotado, Retry-After em segundos |
| 503 | SQLITE_BUSY*, SQLITE_LOCKED* ou aquisição de conexão indisponível: `Não foi possível confirmar a reserva. Tente novamente.` |
| 500 | Falha inesperada: `Não foi possível confirmar a reserva.` |

Constraints inesperadas, como FK/CHECK, não são anunciadas como mero conflito de vaga: recebem 500 genérico e rollback. Os retornos do controller/limitador são JSON/no-store, inclusive com Accept HTML. Falhas anteriores no parser/CSRF usam os handlers existentes. Em 409/503, recarregar e permitir nova tentativa. Não há chave de idempotência: repetir uma confirmação pode retornar 409; se a resposta 201 se perder na rede, o cliente não consegue recuperar a confirmação por telefone/ID. Definir esse fluxo exige etapa própria, sem expor dados publicamente.

## Testes e execução

```bash
npm test -- unit
npm test -- functional
npm run lint
npm run build
```

Executar com ambiente de teste isolado: bootstrap recusa SQLite diferente de `:memory:`; testes de persistência/concorrência usam arquivos temporários próprios e MigrationRunner real. Validação desta etapa roda em cópia descartável com ambiente sintético. Não executar migrations no banco real.

Cobertura inclui confirmação, resolução/legado de cliente, snapshots, calendário/passado/bissexto, tipos/whitelist, privacidade, CSRF e sessão administrativa, limites independentes, rollback em falha real de insert, índice parcial mesmo com adapter obsoleto, duas conexões com reserva/reserva e reserva/calendário, proteção de reservas futuras/em curso, conflitos administrativos atômicos, snapshot de leitura e persistência real de sessão ausente no GET.

Limites do MVP: uma agenda, sem horizonte/antecedência mínima adicionais, sem idempotência de confirmação, autenticação de cliente, notificações ou frontend. A verificação semanal percorre reservas confirmadas não encerradas e recalcula o calendário correspondente; para volumes maiores, revisar consultas/índices e agrupamento por data antes de ampliar o uso.
