# Rate limiter em memória — Etapa 10.1 / R03

Esta correção trata exclusivamente o crescimento de memória e a ordem de verificação no login encontrados em [production-readiness-audit.md](production-readiness-audit.md). Não altera políticas de reservas, autenticação, CSRF, banco ou limites de negócio. A aplicação **não está declarada pronta para produção** por esta correção.

## Consumidores e limites preservados

| Consumidor | Limite e janela fixa | Chave lógica |
| --- | --- | --- |
| Login (`POST /api/admin/login` e `POST /login`) | 30 por IP / 15 minutos | login-ip + IP |
| Login por contato | 5 por IP/e-mail / 15 minutos | login-email + IP + e-mail normalizado |
| Reservas | 10 por IP / minuto | booking-ip + IP |
| Cadastro de clientes | 20 por IP / minuto | customer-ip + IP |
| Disponibilidade | 60 por IP / minuto | availability-ip + IP |

Os dois endpoints de login compartilham os mesmos orçamentos, como antes. A origem do IP continua sendo `ctx.request.ip()` conforme TRUST_PROXY; não foi criada leitura manual de X-Forwarded-For.

Fontes: [serviço](../app/services/rate_limiter.ts), [login](../app/middleware/login_rate_limit_middleware.ts), [reservas](../app/middleware/booking_rate_limit_middleware.ts), [clientes](../app/middleware/customer_rate_limit_middleware.ts), [disponibilidade](../app/middleware/availability_rate_limit_middleware.ts) e [rotas](../start/routes.ts).

## Estrutura e expiração

`InMemoryRateLimiter` contém o Map e permite relógio/capacidade internos injetados para testes determinísticos. A instância compartilhada `rateLimiter` atende os wrappers compatíveis `checkRateLimit()` e `resetRateLimiter()`. O getter `size` fornece apenas a contagem agregada; nenhum endpoint HTTP de diagnóstico foi criado e nenhuma identidade/chave é exposta.

Cada janela começa na primeira tentativa permitida daquela chave. A contagem não desliza nem prolonga o vencimento quando a chave é consultada ou recusada. Até o limite, a tentativa incrementa o contador; depois dele retorna `allowed:false`, remaining=0 e Retry-After arredondado para cima, no mínimo um segundo nas recusas.

A limpeza é **global e oportunista**, disparada na próxima chamada ao serviço quando transcorreram pelo menos 1.000 ms desde a última varredura. Ela remove todas as entradas cujo expiresAt <= now, inclusive chaves que nunca voltaram. Não altera contagem ou vencimento de entradas ainda ativas. Uma chave própria já vencida também pode ser removida/renovada imediatamente, mesmo entre varreduras, preservando a fronteira exata de sua janela.

Não há setInterval, setTimeout, timer por chave ou agendamento de background. Em total ociosidade, entradas vencidas podem permanecer até a próxima atividade; continuam limitadas pela capacidade. Isso evita recursos pendentes em testes/processo e atende à coleta por tráfego de outras chaves, sem exigir o retorno da identidade antiga. Uma varredura custa O(capacidade), no máximo uma por segundo de atividade; os demais checks são O(1) sobre o Map mais o hash da chave recebida. Não é uma promessa de latência sob qualquer carga.

## Capacidade e tamanho das chaves

A instância compartilhada tem capacidade de **10.000 entradas**, somando todos os consumidores. Cada chave lógica é transformada em SHA-256 hexadecimal antes de armazenar: o identificador retido tem sempre 64 caracteres, mesmo se a entrada original recebida antes da validação tiver tamanho elevado. Namespaces e normalização de e-mail continuam distinguindo os mesmos orçamentos. Hash não é autenticação nem mecanismo de anonimização garantida para exportação; essas chaves não são publicadas.

O limite controla quantidade de entradas **e tamanho de seus identificadores retidos**. Não limita toda a memória do processo, body parser, sessões ou buffers temporários: esses continuam sendo responsabilidades próprias, fora de R03. Não há dependências novas, novas variáveis de ambiente ou alteração de lockfile.

### Saturação segura

1. Entradas ativas nunca são expulsas por LRU, FIFO ou pressão de capacidade.
2. Chaves já conhecidas continuam usando seus contadores: se esgotados, permanecem recusados; se houver orçamento, podem ser atendidas conforme o limite original.
3. Uma chave nova sem vaga é recusada sem inserção, com `allowed:false`, remaining=0. Os middlewares existentes traduzem isso para 429 JSON e mantêm suas mensagens.
4. Retry-After de saturação usa a expiração mais próxima conhecida, arredondada em segundos, no mínimo um. Não promete admissão na próxima tentativa, pois outra requisição pode ocupar a vaga.
5. A próxima varredura recupera vagas expiradas. Entre varreduras, a recusa pode ser conservadora por até um segundo de atividade. Se a expiração mínima estiver vencida ou não finita ao recusar uma chave desconhecida por saturação, ela é recalculada sobre as entradas retidas. Isso corrige a renovação direta da chave mais próxima entre varreduras: o Retry-After passa a refletir a próxima expiração real, sem remover entradas ativas. Essa varredura adicional é restrita à saturação com metadado obsoleto; chamadas normais e recusas com mínimo ainda válido não a executam. Entradas realmente vencidas de outras chaves ainda podem levar à recusa conservadora de um segundo até a próxima limpeza global.

A saturação pode recusar clientes legítimos com chaves novas. Essa é uma escolha explícita de disponibilidade degradada para preservar memória e impedir bypass por expulsão de contadores. Um flood sustentado ainda pode manter pressão sobre a capacidade; a correção não pretende resolver todo DoS, criar cotas por telefone ou substituir proteções de borda.

## Ordem de login e efeitos de contagem

O middleware consulta **primeiro o IP**. Se for recusado, devolve 429/Retry-After e encerra antes de ler/normalizar o e-mail, criar/consultar seu contador ou chamar o próximo handler de autenticação.

Se o IP for permitido, o e-mail continua sendo normalizado com trim/lowercase e consulta o orçamento IP/e-mail. E-mail esgotado recebe 429; caso contrário, segue a validação/credenciais. X-RateLimit-Remaining continua refletindo o orçamento por IP/e-mail no login permitido, preservando o contrato anterior.

O IP continua sendo contado nas tentativas encaminhadas ao limite por e-mail, mesmo se este negar, se as credenciais forem inválidas ou se a autenticação tiver sucesso. Não se restitui orçamento em falha de credencial nem se reinicia a janela após login válido. A diferença intencional é que uma tentativa já recusada por IP deixa de consumir/criar contador de e-mail. Se IP for conhecido e permitido, mas o novo contador de e-mail for recusado por capacidade, o consumo do IP também permanece: política conservadora, sem bypass.

O pipeline global de body parser, sessão, Shield e silent auth não foi reorganizado: a recusa evita o controller/verificação de credenciais, sem prometer eliminar trabalhos que já ocorreram em middlewares anteriores. O wrapper stateless de GET availability permanece intacto e continua limitando antes de sessão/CSRF para essa rota exata.

## Testes e evidências

Foram adicionados **13 unitários e 4 funcionais**:

- Janelas fixas, fronteira de vencimento, arredondamento de Retry-After, renovação e coleta por uma chave diferente.
- Regressão determinística da renovação direta entre varreduras com três expirações diferentes: Retry-After de 20 segundos, recusa sem expulsão e recuperação na próxima expiração.
- Limpeza preservando contadores ativos; capacidade pequena sem expulsão; recusa conservadora entre varreduras; recuperação após expiração.
- Carga controlada de 20.000 chaves, entrada original longa, distinção de namespaces, reset e configuração interna inválida.
- 500 chamadores por Promise.all no mesmo processo: somente 30 permissões para orçamento 30. Não representa concorrência entre processos.
- IP bloqueado não lê e-mail, não cria chave, não incrementa um contador de e-mail existente e não chama o próximo handler.
- HTTP real: 30 credenciais inválidas e depois 40 novos e-mails recebem 429 **sem aumentar as 31 chaves existentes**; credencial correta também não autentica quando o IP está bloqueado.
- Cinco tentativas por IP/e-mail continuam valendo, inclusive normalização; outro e-mail pode autenticar enquanto o orçamento de IP permite.
- Login/sessão, POST sem CSRF recusado, sessão preservada após essa recusa e logout reais continuam válidos.
- Capacidade real de 10.000: após 20.000 chaves sintéticas, permanece em 10.000; disponibilidade, clientes, reservas e login recusam novas chaves com 429/Retry-After; contador bloqueado não é reaberto e nenhuma reserva é criada.

Uma reprodução adicional com o **serviço real e relógio injetado**, sem banco ou rede, usou a capacidade de 10.000:

| Medida | Resultado |
| --- | --- |
| Novas chaves tentadas | 20.000 |
| Admitidas/retidas antes do vencimento | 10.000 / 10.000 |
| Chave já bloqueada continua recusada | Sim |
| Após vencer as 10.000 e consultar chave diferente | Uma nova entrada; as antigas foram recolhidas |

Na execução backend final: **286 aprovados, zero reprovados** (113 unitários e 173 funcionais), incluindo regressões de reservas, clientes, disponibilidade, sessão, CSRF e calendário. Lint e build aprovados. Typecheck mantém **somente os oito diagnósticos preexistentes do Inertia**, em marketing/signup, sem correções fora do escopo. As verificações são feitas numa cópia descartável e SQLite de teste; nenhuma migration no banco original.

Os **44 E2E reais passaram**, em desktop e mobile, pelo harness do frontend sem alterar seu código, com backend e SQLite descartáveis. O harness confirmou a preservação dos arquivos originais. Somando as suítes, são **330 testes aprovados**. Testes de componentes com mocks não são apresentados como prova de integração. Não foram feitos ataques contra serviços públicos.

```bash
# Em ambiente de teste isolado, conforme o bootstrap existente:
npm test
npm run lint
npm run typecheck
npm run build
# No frontend sem alterações, com backend desta branch na pasta irmã:
E2E_BROWSER_CHANNEL=chrome npm run test:e2e
```

## Limitações residuais

- Estado por processo; reinício perde contadores. Várias instâncias/workers têm orçamentos e capacidades independentes, podendo multiplicar o tráfego total permitido. Este trabalho não oferece limitação distribuída.
- Capacidade compartilhada pode produzir recusa temporária para novas identidades; monitorar saturação e considerar os limites da borda/deploy. Redis/serviço externo só deve ser avaliado se a arquitetura real exigir coordenação entre instâncias.
- Date.now mantém a base temporal anterior; ajustes do relógio não são um novo mecanismo distribuído. Não foram feitos testes de carga de longa duração ou promessa de throughput.
- O hash limita o identificador armazenado, mas não evita o custo de parsing de uma requisição recebida. Login bloqueado por IP evita ler/hashear o e-mail; outras proteções permanecem conforme os middlewares anteriores.
- R04 (política contra ocupação abusiva), implantação, backup, logs e os demais achados da auditoria não foram corrigidos nesta subetapa. A revisão técnica deve aprovar R03 antes do merge; não se declara a aplicação pronta para produção.

Os resultados acima são relatados pelo Codex a partir de execuções locais em ambientes isolados. A PR não possui workflows/checks do GitHub que forneçam verificação independente automática; a revisão técnica continua necessária.
