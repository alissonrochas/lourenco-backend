# Plano técnico da agenda do MVP

Este documento é uma proposta para próximas PRs. Nenhuma tabela ou API de agenda descrita aqui existe nesta etapa. A implementação atual acrescenta somente `GET /api/services`.

## Regras confirmadas

- Um barbeiro, uma agenda compartilhada, sem cadastro de profissionais no MVP.
- Clientes agendam sem conta, senha ou sessão de cliente. Somente administradores gerenciam a agenda.
- Cada reserva ocupa exatamente 60 minutos, começando em hora cheia local (09:00, 10:00 etc.). Uma reserva por bloco.
- `Service.durationMinutes` continua no catálogo, mas não determina o tamanho do bloco nesta versão, mesmo quando ultrapassa 60 minutos. Uma eventual mudança dessa regra exigirá revisão explícita do produto.
- Datas e horários locais são interpretados em `America/Sao_Paulo`, usando as regras desse fuso, sem presumir permanentemente um deslocamento UTC fixo. Instantes persistidos em UTC; respostas devem identificar o fuso e incluir offset nos horários.
- Funcionamento, intervalos e bloqueios são persistidos no backend e editáveis pelo painel futuro, sem editar código ou banco manualmente.

## Organização proposta

Manter controllers pequenos, validators VineJS, models Lucid e transformers com campos permitidos. Um serviço de domínio de disponibilidade reúne as regras de calendário; um serviço de reserva reutiliza esse cálculo dentro de uma transação. O frontend apenas apresenta os horários fornecidos pelo backend.

A disponibilidade é calculada, não armazenada como uma cópia independente do calendário. Não criar abstrações para múltiplos barbeiros, filas ou tabelas de usuários de clientes nesta versão.

## Possíveis tabelas

| Tabela proposta | Campos e responsabilidades |
| --- | --- |
| `booking_settings` | Registro único: timezone da barbearia, limite de antecedência/horizonte a definir com o produto e revisão da configuração. O fuso inicial é `America/Sao_Paulo`. |
| `weekly_opening_hours` | Um registro por dia da semana, `weekday` único, `is_active`, abertura e fechamento em minutos locais desde meia-noite, timestamps. Dia desativado não oferece blocos. |
| `weekly_breaks` | Dia da semana, início/fim local e status. Permite almoço e outros intervalos recorrentes; FK para o dia configurado. |
| `weekly_slot_blocks` | Dia e hora cheia local, combinação única e status de bloqueio. Permite desativar/reativar um bloco recorrente específico sem fragmentar os horários de funcionamento. |
| `date_blocks` | Data local única, status de bloqueio integral, motivo administrativo opcional e timestamps. Ex.: feriados e folgas. |
| `date_slot_blocks` | Data local e hora cheia, combinação única, status e motivo opcional. Ex.: ausência excepcional de uma hora. |
| `bookings` | ID, cliente existente, serviço, início/fim UTC, status confirmado/cancelado, snapshots do nome e preço do serviço, timestamps e dados administrativos de cancelamento. |
| `booking_events` | Reserva, ação, administrador responsável quando aplicável, instante e motivo. Preserva histórico de cancelamento e alterações administrativas relevantes sem expor dados publicamente. |

Usar inteiros para minutos e centavos, FKs, CHECKs de intervalos e duração do bloco e índices para consultas por data/status. A unidade do dia da semana deve ser documentada (proposta: ISO 1–7). Inicialmente não permitir funcionamento atravessando meia-noite: validar abertura < fechamento, valores entre 0 e 1440 e intervalos dentro do dia. Exigir limites de funcionamento, intervalos e bloqueios em horas cheias nesta versão evita blocos parcialmente disponíveis e configurações ambíguas. Confirmar essa escolha de UX na PR de configuração.

Não duplicar a tabela de clientes. Telefones normalizados continuam com as garantias atuais de integridade; a resolução de clientes legados com normalização nula deve reutilizar o comportamento de privacidade existente e nunca fundir cadastros automaticamente por suposição.

## Cálculo de disponibilidade

Para uma data local válida dentro do horizonte permitido:

1. Interpretar a data no fuso da barbearia e carregar configurações persistidas.
2. Verificar dia semanal ativo e ausência de bloqueio integral da data.
3. Gerar candidatos em horas cheias cujo intervalo completo de 60 minutos caiba entre abertura e fechamento.
4. Remover candidatos que intersectem intervalos recorrentes, blocos semanais desativados ou bloqueios específicos da data.
5. Converter os instantes para UTC e remover horários passados e blocos ocupados por reservas confirmadas.
6. Retornar apenas os horários disponíveis, sem cliente, telefone, motivo privado do bloqueio ou detalhes das reservas ocupantes.

Regras de fechamento e bloqueio prevalecem sobre liberação. Remover um bloqueio excepcional não abre um dia semanal fechado nem ignora outro bloqueio ou reserva. Liberar novamente um horário significa retirar o bloqueio correspondente e recalcular as demais regras. Uma data/hora local inexistente ou ambígua deve ser recusada ou resolvida por política explícita, nunca convertida silenciosamente.

Serviços inativos não podem ser escolhidos para novas reservas. Validar o serviço novamente ao confirmar, mesmo que tenha aparecido antes no catálogo. O catálogo e a disponibilidade consultados não garantem a reserva do horário.

## Persistência e concorrência

O POST de reserva deve validar entrada e revalidar serviço ativo, funcionamento, bloqueios e ocupação dentro da mesma transação que grava a reserva. Não confiar na disponibilidade enviada pelo navegador.

No SQLite, propor índice único parcial em `bookings(starts_at)` para reservas com status confirmado. Como todos os blocos têm 60 minutos e começam em horas cheias na única agenda, essa unicidade impede duas reservas ativas do mesmo bloco, inclusive em requisições simultâneas. Manter cancelamentos na tabela; o índice libera o bloco quando o status muda para cancelado.

A unicidade isolada não impede corrida entre uma reserva e um novo bloqueio. As operações de reserva e alteração de calendário devem compartilhar uma estratégia transacional de escrita: adquirir a trava SQLite antes das leituras decisivas (por exemplo, transação IMMEDIATE, conforme suporte do driver instalado), reconsultar as regras e só então escrever. Validar essa estratégia com testes reais de duas conexões. Tratar SQLITE_BUSY com política limitada de retry/erro controlado; nunca assumir sucesso. Violação da unicidade retorna 409 JSON genérico de horário indisponível, sem identificar o outro cliente.

Preço/nome do serviço devem ser copiados para a reserva para preservar o histórico após edições no catálogo. Datas de criação e histórico não devem ser alterados pelo cliente. Se for adicionada idempotência para repetição de envio, vincular chave e payload e evitar transformar a chave em consulta pública de dados pessoais; definir retenção e testes na PR de reservas.

## Alterações de configuração e reservas existentes

Uma alteração de funcionamento ou bloqueio nunca cancela ou move reservas silenciosamente. Antes de salvar, identificar reservas confirmadas atingidas e apresentar conflito ao administrador. Proposta inicial: recusar com 409 e resumo administrativo dos conflitos, exigindo que ele resolva cada reserva por uma ação de cancelamento explícita e auditada antes de tentar a alteração novamente.

Essa verificação deve ocorrer sob a mesma proteção transacional das novas reservas. Edição de serviço ou sua desativação não altera reservas confirmadas; snapshots preservam os dados contratados. Alterar timezone após haver reservas requer uma migração/regra específica fora do MVP; não permitir uma simples edição que reinterprete instantes existentes.

Cancelamento administrativo deve exigir sessão, papel admin atual, CSRF, motivo e transição válida, salvando evento na mesma transação. Repetição de cancelamento não deve duplicar eventos ou apagar registros. Não permitir cancelamento público usando somente ID ou telefone. Acesso do cliente a cancelamento/consulta futura, se necessário, exigirá mecanismo separado com token não adivinhável e política própria; não é requisito implementado aqui.

## APIs futuras propostas

Todos os caminhos abaixo são planejamento e podem ser ajustados em PRs pequenas. Respostas seguem camelCase e envelope `data`, com erros JSON e serializers explícitos.

| Área | Endpoints propostos | Regras |
| --- | --- | --- |
| Configuração semanal | `GET /api/admin/booking-settings`, `PATCH /api/admin/booking-settings` | Atualizar dias ativos, abertura/fechamento, intervalos e blocos recorrentes; validar sobreposição e conflitos com reservas. |
| Exceções por data | `GET /api/admin/calendar-exceptions?from=...&to=...`, `POST /api/admin/calendar-exceptions`, `PATCH /api/admin/calendar-exceptions/:id` | Bloquear data inteira ou hora específica; desativar o bloqueio para liberar, preservando rastreabilidade. |
| Gestão de reservas | `GET /api/admin/bookings?date=...`, `GET /api/admin/bookings/:id`, `POST /api/admin/bookings/:id/cancel` | Dados pessoais só para administrador; cancelamento explícito com histórico. |
| Disponibilidade pública | `GET /api/availability?date=YYYY-MM-DD&serviceId=...` | Lista limitada de horários livres e timezone, sem dados de outras pessoas. |
| Reserva pública | `POST /api/bookings` | Nome, telefone, serviço e horário; sem login, com CSRF e rate limiting, validação e transação. |

Reutilizar `adminAuth` e CSRF global em toda escrita; GET público não exige token. Não adicionar uma autenticação paralela. Respostas administrativas/pessoais usam no-store; disponibilidade também deve evitar cache obsoleto. Validar IDs, datas, limites de consulta e campos permitidos; não aceitar status, preço, cliente arbitrário, ID, timestamps ou papel administrativo por mass assignment.

A criação pública deve fornecer uma confirmação mínima da reserva, sem expor cadastro interno ou revelar se o telefone já existia. Telefone identifica contato, não autentica alguém. A resposta de conflito de horário é necessária à operação, mas não deve incluir nome, telefone ou existência de um cliente específico. Reutilizar as proteções de privacidade, normalização de telefone, CSRF e rate limiting existentes; configurar TRUST_PROXY corretamente. O limitador em memória continua restrito ao processo e reinicia com ele; implantação com múltiplas instâncias exigirá armazenamento compartilhado antes de depender dessa proteção globalmente.

## Estratégia de testes e migrações

- Migrations aditivas e reversíveis, exercitadas pelo Lucid em SQLite temporário, preservando tabelas e registros atuais. Nunca executar migrations no banco de desenvolvimento como parte dos testes.
- Testes unitários da geração de blocos: dias fechados, limites de abertura, intervalos, bloqueios, reabertura, horários passados, timezone e serviço cuja duração difere de 60 minutos.
- Testes funcionais de autenticação, permissão revogada, CSRF, whitelist, validação e não exposição de dados pessoais.
- Testes transacionais com conexões independentes ao mesmo SQLite temporário: duas reservas do mesmo bloco, reserva concorrente com bloqueio, cancelamento e nova reserva. Verificar no máximo uma confirmação e erros controlados.
- Verificar que mudanças de horário, bloqueios ou serviço não removem nem alteram silenciosamente reservas e seus snapshots; cancelamentos geram histórico atômico.
- Manter todos os testes atuais, lint e build em cada PR. Revisar índices e consultas antes de implementar paginação ou abstrações adicionais.

## Ordem recomendada das próximas PRs

1. **Dados de funcionamento:** migrations, models e testes isolados de configuração semanal, intervalos e bloqueios, sem endpoints.
2. **API administrativa de funcionamento:** leitura/edição, CSRF, validação e persistência, sem interface ainda.
3. **Exceções de calendário:** dados e API administrativa para bloqueios por data/hora e liberação, com testes.
4. **Cálculo de disponibilidade:** serviço de domínio, regras de fuso e blocos fixos, testes de fronteira; sem gravação pública.
5. **Dados de reservas e histórico:** migrations, models, índice único parcial, snapshots e testes de concorrência/transações.
6. **Gestão administrativa de reservas:** consulta e cancelamento auditado; integrar a proteção de reservas existentes às alterações de calendário antes de habilitar reservas públicas.
7. **Disponibilidade pública:** endpoint com limites de consulta, privacidade e testes.
8. **Reserva pública:** contato sem conta, revalidação transacional, tratamento de concorrência, CSRF e rate limiting. Revisão de segurança antes de expor escrita pública.
9. **Frontend em etapas:** catálogo, painel de configuração, gestão e fluxo público de reserva em PRs separadas, consumindo contratos já revisados.

Antes de cada etapa, confirmar as decisões ainda abertas: horizonte de reserva, antecedência mínima, política operacional de cancelamento, conteúdo mínimo da confirmação e retenção de dados. Não presumir essas regras em constantes de frontend.
