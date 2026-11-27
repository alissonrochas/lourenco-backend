# Política pública de agendamento — R04 / Etapa 10.2A

Esta política reduz ocupação abusiva da agenda sem autenticar clientes. Não declara a aplicação pronta para produção e não resolve todos os demais achados da auditoria.

## Configuração e semântica

`config/booking_policy.ts` centraliza `advanceDays: 30` e `maxFutureBookings: 2`. A configuração é de servidor, versionada e aplicada mediante revisão/deploy; não vem de parâmetros públicos, não há interface administrativa ou variáveis novas no ambiente. Valores inteiros são validados. A configuração pode ser injetada em testes sem modificar o padrão de produção.

- Datas públicas: hoje em `America/Sao_Paulo` até hoje + 30 dias corridos, inclusive (31 datas selecionáveis).
- A soma usa dias de calendário locais, não 30 * 24 horas UTC; considera viradas de mês/ano, bissextos e transições históricas de horário de verão.
- No dia atual, o motor existente continua recusando horários iniciados ou com início exatamente igual ao instante atual.
- Cota: no máximo duas reservas com `status = confirmed` e `starts_at_utc > now`. Abrange todos os serviços e todas as datas, inclusive reservas anteriores à política e além do horizonte.
- Reservas canceladas e já iniciadas não consomem a cota, mesmo se continuam com status `confirmed`. Não há criação de estado “concluída”.
- Reservas existentes não são canceladas, excluídas, renomeadas ou reprecificadas. Famílias com o mesmo telefone compartilham a cota. Não há exceção por serviço.
- Não há endpoint administrativo de criação de reservas nesta versão. A política não acrescenta um bypass público nem altera listagem/cancelamento administrativo.

O motor puro e `BookingAvailabilityService.calculate()` continuam disponíveis sem o horizonte público para regras internas, proteção administrativa e histórico. Somente `calculatePublic()` e a criação pública aplicam a política de admissão.

## Telefones e legados

Mantém-se `normalizePhone`: remoção de caracteres não numéricos. Espaços, parênteses e hífens não criam cotas separadas. **Prefixo 55 não é adicionado nem removido**; equivalência entre números nacionais e internacionais não foi aprovada.

Na transação de criação, uma consulta conta confirmações futuras unidas a clientes com `phone_normalized` igual à chave normalizada recebida. Se essa contagem já esgota a cota, a operação é recusada sem consulta adicional a legados. Caso contrário, outra consulta agrupa confirmações futuras por cliente legado com `phone_normalized IS NULL`, selecionando apenas ID, telefone e contagem; a aplicação normaliza esses telefones com a mesma função e soma os equivalentes.

Isso inclui duplicados legados e contatos canônicos simultaneamente, sem depender somente do `customerId` escolhido para a nova reserva, sem listas SQL IN de tamanho variável e sem reescrever/fundir dados antigos. Não consulta todo o histórico de reservas canceladas/iniciadas para montar a lista. A consulta de legados pode crescer com a quantidade de contatos legados que ainda tenham reservas futuras. Não foi criada migration/índice especulativo: os índices existentes são preservados; otimização adicional exige medição em banco descartável.

## Transação, concorrência e falhas

1. Abrir transação.
2. Executar o UPDATE sem mudança de valor em `booking_settings` para adquirir o bloqueio de escrita existente, inclusive quando a tabela estiver vazia.
3. Capturar **uma vez** o relógio após o bloqueio.
4. Validar horizonte e contar reservas pelo telefone normalizado/legados usando a mesma conexão transacional.
5. Recusar a cota esgotada antes de criar cliente.
6. Resolver/criar cliente sem alterar registros existentes, validar serviço e disponibilidade com o mesmo instante e transação.
7. Criar a reserva com snapshots e confirmar; qualquer falha reverte as escritas.

Criação, cancelamento e alterações de calendário continuam compartilhando a serialização de escrita do SQLite, e o índice único parcial de início UTC confirmado permanece como barreira final para o horário. Duas conexões disputando horários diferentes não podem confirmar ambas após observar a mesma última posição da cota. Um concorrente pode receber 503 por contenção, conforme contrato existente; nenhuma tentativa automática de POST foi acrescentada. Após cancelamento confirmado antes da criação, a contagem enxerga a vaga liberada. Se a criação ocorrer antes, vale o estado anterior ao cancelamento.

Não se usa mutex em memória para a cota: múltiplos processos acessando o **mesmo SQLite** dependem do bloqueio do banco. Bancos diferentes não compartilham reservas/cotas. Os limites de tráfego continuam sendo por processo, conforme a documentação do rate limiter.

## Contrato HTTP

### GET /api/availability?date=YYYY-MM-DD

Mantém `data.localDate`, `weekday`, `timezone`, `slotDurationMinutes` e `slots`. Acrescenta apenas `data.policy`:

```json
{
  "data": {
    "localDate": "2026-11-10",
    "weekday": 2,
    "timezone": "America/Sao_Paulo",
    "slotDurationMinutes": 60,
    "policy": { "minDate": "2026-11-10", "maxDate": "2026-12-10", "timezone": "America/Sao_Paulo" },
    "slots": []
  }
}
```

O frontend futuro pode consultar a data atual ao entrar na etapa de data e usar esses limites. Datas reais fora da janela retornam 422 com os limites públicos, incluindo quando a data inicial presumida pelo navegador estiver incorreta. Sem endpoint novo, consulta por telefone, personalização por cliente, cookies/sessão ou escrita nesta leitura. Proteções e headers da disponibilidade stateless permanecem intactos.

### GET e POST com data fora da janela

```json
{
  "code": "BOOKING_DATE_OUT_OF_RANGE",
  "message": "Escolha uma data dentro do período de agendamento.",
  "policy": { "minDate": "2026-11-10", "maxDate": "2026-12-10", "timezone": "America/Sao_Paulo" }
}
```

Status 422. Datas malformadas continuam no erro de validação existente; os limites acima só são retornados após validação de data real.

### POST /api/bookings com cota esgotada

```json
{
  "code": "PUBLIC_BOOKING_NOT_ACCEPTED",
  "message": "Não foi possível concluir a reserva pelo site. Entre em contato com a barbearia."
}
```

Status 422, **sem Retry-After**, contagens, datas/IDs de outras reservas, dados de clientes ou detalhes SQL. Essa recusa pode preceder a verificação de serviço e disponibilidade. Criação válida continua 201 no contrato existente, horário ocupado/indisponível continua 409, tráfego excedido continua 429 com Retry-After, e contenção continua 503. Cache-Control: no-store preservado. O limite de 10 tentativas/IP/minuto, sessões, autenticação administrativa e CSRF não mudaram.

## Privacidade e limitações

O telefone é declarado, não verificado: pode ser falso ou de terceiros. Uma mensagem genérica reduz exposição direta, mas a diferença entre sucesso e recusa pode permitir inferência indireta sobre utilização do contato. Também é possível consumir a cota de outra pessoa. Não há garantia de identidade ou anonimização, nem proteção completa contra vários telefones/IPs ou abuso sustentado. Nenhum telefone foi incluído na consulta de disponibilidade, URLs ou logs.

A disponibilidade permanece coletiva: um horário livre pode ser mostrado a alguém cuja próxima reserva seria recusada pela cota. Não se esconde o horário para todos por causa da identidade de um contato. Não se acrescentaram CAPTCHA, SMS, autenticação de cliente, Redis ou dependências.

## Compatibilidade com frontend atual

O parser atual tolera o campo adicional `data.policy`; as confirmações 201 mantêm exatamente seus campos. Porém a interface ainda usa max=9999-12-31, não lê os limites do servidor e trata todos os 422 do POST como dados/serviço inválidos. Assim, não consegue orientar especificamente recusas de horizonte/cota. Isso é uma limitação de UX para a Etapa 10.2B, não um bypass: o backend rejeita a operação e o frontend não apresenta confirmação de sucesso.

O E2E original de paginação prepara 51 reservas futuras pelo mesmo telefone através do serviço de criação pública. Esse fixture conflita intencionalmente com a nova cota e precisa ser atualizado em etapa de frontend/testes posterior. Não alterar a política real para admitir a fixture. A integração pode ser verificada adicionalmente em cópia descartável do harness, variando somente os telefones sintéticos da fixture e mantendo todas as asserções.

## Verificação

Executar `npm test`, `npm run lint`, `npm run build` e `npm run typecheck` em cópia descartável; bootstrap recusa banco de teste diferente de :memory:. Testes de concorrência criam arquivos SQLite temporários com duas conexões independentes, removidos no finally. Nunca executar migrations no banco original.

A cobertura inclui limites inclusivos, viradas de calendário/local midnight e horário de verão histórico; cota entre serviços e formatos equivalentes; legados nulos/duplicados e reservas fora do horizonte; cancelamento e reservas iniciadas; HTTP genérico, ausência de dados pessoais, CSRF, rate limiting e autenticação; concorrência pela última vaga e cancelamento nas duas ordens efetivas de transação. Os testes anteriores mantêm asserções de calendário, snapshots e unicidade. Fixtures públicas antigas tiveram seus relógios alinhados ao horizonte; fixtures administrativas de histórico usam inserção explícita pelo model para representar dados preexistentes, sem contornar a política em produção.

Resultados finais e eventuais falhas de integração estão registrados na PR. São execuções locais isoladas relatadas pelo Codex; não equivalem a checks independentes de CI. Os oito diagnósticos preexistentes do Inertia permanecem fora do escopo.

### Resultado da execução desta etapa

- Backend: **310 aprovados** (130 unitários e 180 funcionais), incluindo **24 novos testes** (17 unitários e sete funcionais). Lint e build aprovados; typecheck apresenta somente os oito diagnósticos preexistentes do Inertia, nenhum novo.
- Houve timeouts variáveis em testes antigos que criam bancos SQLite em arquivo em disco. A execução final usou `TMPDIR=/dev/shm` para os temporários da cópia e dos testes, mantendo os timeouts e asserções originais; `npm test` passou em cerca de 10 segundos. Os bancos continuam sendo SQLite reais, inclusive arquivos com duas conexões nos testes de concorrência; não foram substituídos por mocks.
- E2E original, sem alteração do frontend: **42 aprovados, duas falhas**. As duas são a fixture de paginação (desktop/mobile), recusada ao tentar a terceira reserva pública do mesmo telefone; não são falhas de asserções da tela de paginação. O harness confirmou preservação dos arquivos originais.

Para reproduzir a integração adicional compatível, usar uma cópia descartável do frontend e dependências existentes, com `E2E_BACKEND_PATH` apontando para esta branch. Somente na cópia de `e2e/backend-fixture.stub`, na fixture de paginação, substituir `phone: '71970000000'` por `phone: String(71970000000 + created)`. Isso mantém o primeiro contato esperado e as 51 reservas, sem exceder a cota de nenhum telefone e sem mudar asserções ou código de aplicação. Executar `E2E_BROWSER_CHANNEL=chrome npm run test:e2e` nessa cópia. O repositório frontend original e seus testes não são modificados por esta PR.

Na execução adicional compatível, **44 E2E reais passaram** em desktop/mobile, com exit 0 e preservação confirmada pelo harness. Somente os telefones sintéticos da fixture de paginação foram variados; código frontend e todas as asserções foram mantidos. A cópia incluiu metadados Git independentes para a coleta final das revisões; nenhuma branch original foi alterada. Este resultado adicional não transforma as duas falhas da suíte original em aprovações.
