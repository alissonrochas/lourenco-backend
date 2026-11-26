# API pública de consulta de disponibilidade

`GET /api/availability?date=YYYY-MM-DD` permite consultar o calendário sem login ou preparação de CSRF. Usa diretamente BookingAvailabilityService, descrito em [booking-availability-engine.md](booking-availability-engine.md). Nenhuma regra de calendário foi reimplementada no controller.

## Parâmetros

Somente `date`, obrigatório, string canônica com data real do calendário gregoriano, entre os anos 0001 e 9999. Aceita anos bissextos válidos como 2028-02-29; rejeita 2026-02-29, datas impossíveis, espaços, outros formatos, timestamps, objetos e arrays.

A query bruta deve conter exatamente uma chave date. Repetições são rejeitadas mesmo com valores iguais, inclusive chaves codificadas equivalentes; chaves desconhecidas são recusadas antes e depois do parser. Não aceita serviceId, duração, now, timezone ou opções administrativas. O instante de referência é exclusivamente do servidor.

Não há antecedência mínima ou horizonte de reservas novo. Datas passadas, dias fechados e dias sem configuração são consultas válidas e retornam 200 com slots vazio.

## Resposta

Envelope data e Cache-Control: no-store. weekday foi mantido por consistência com o motor: ISO 1–7, segunda a domingo. Os slots omitem a localDate redundante e seguem uma whitelist explícita, independente de eventuais campos futuros do serviço.

Exemplo ilustrativo para um dia cujo funcionamento foi configurado pelo administrador como 09:00–10:00, consultado antes do início:

```json
{
  "data": {
    "localDate": "2026-12-25",
    "weekday": 5,
    "timezone": "America/Sao_Paulo",
    "slotDurationMinutes": 60,
    "slots": [
      {
        "startsAtMinute": 540,
        "endsAtMinute": 600,
        "startsAtLocal": "2026-12-25T09:00:00.000",
        "endsAtLocal": "2026-12-25T10:00:00.000",
        "startsAtUtc": "2026-12-25T12:00:00.000Z",
        "endsAtUtc": "2026-12-25T13:00:00.000Z",
        "startOffsetMinutes": -180,
        "endOffsetMinutes": -180
      }
    ]
  }
}
```

Esse exemplo não define expediente padrão nem garante que a data esteja disponível. Sem horários elegíveis, o mesmo contrato retorna slots: [].

- startsAtMinute/endsAtMinute são minutos locais desde meia-noite; 1440 é somente o término 24:00, na próxima data local.
- startsAtLocal/endsAtLocal são horários de parede sem offset; não devem ser interpretados como UTC. Para instantes inequívocos, usar startsAtUtc/endsAtUtc com Z. Os offsets reais estão nos campos separados, em minutos.
- America/Sao_Paulo é o fuso da agenda. Não presumir offset constante: o motor resolve o fuso IANA, rejeita fronteiras inexistentes/ambíguas e exige 60 minutos reais.
- O início precisa ser estritamente futuro; blocos iniciados ou começando exatamente na referência não aparecem.
- Pausas e qualquer bloqueio ativo prevalecem. Uma liberação não abre um dia fechado nem anula outros impedimentos.

## Implementação e privacidade

Controller valida a query com VineJS e o validador de calendário real existente, chama BookingAvailabilityService e serializa com PublicAvailabilityTransformer. O motor permanece intacto: dia da semana, pausas, bloqueios, UTC e passado são calculados somente por ele. Não há serviceId ou consulta de catálogo.

Não há escrita de configuração, criação de clientes, persistência de disponibilidade ou cache do resultado. As consultas usam o snapshot do serviço existente. Alterações administrativas passam a afetar consultas seguintes automaticamente, sem reconstrução de cache. O GET dessa rota é sem estado de sessão: não inicializa sessão/autenticação, não gera segredo CSRF nem envia cookies de sessão/XSRF. Os outros endpoints preservam o fluxo original, conforme a estratégia abaixo.

A resposta JSON não contém motivos administrativos, IDs de configuração, clientes, sessões, tokens, timestamps internos ou detalhes do banco. Razões de fechamento também não são publicadas; slots vazio é suficiente. Erros inesperados são registrados no servidor e convertidos em mensagem pública genérica, sem stack/SQL na resposta.

## Consulta sem estado e encadeamento dos middlewares

A versão instalada do Adonis executa os middlewares de servidor, identifica a rota e atribui `ctx.route`, e só então executa os middlewares globais do roteador seguidos dos middlewares específicos da rota. Portanto, o rate limiter apenas na rota era tardio: o Shield podia criar o segredo CSRF e a camada de sessão persistia essa alteração, mesmo em GET ou em respostas 429.

A correção é restrita por três condições simultâneas: método **GET**, nome `public.bookingAvailability` e padrão de rota `/api/availability`. Nome e padrão vêm da rota efetivamente encontrada pelo router, não de headers, parâmetros ou comparação de prefixos de URL. O teste unitário usa o matcher real para construir essa identidade. URLs que o próprio router normalizar para a mesma rota continuam identificadas pela rota encontrada, não por uma segunda implementação de roteamento.

`availability_state_middleware.ts` fornece wrappers nos quatro pontos já existentes de sessão, Shield, inicialização de auth e silent auth. Para todas as demais rotas/métodos, cada wrapper resolve e chama o middleware original pelo container, mantendo bindings, configuração e a ordem original. Os middlewares de servidor e body parser permanecem inalterados. Não há desativação global de sessão, autenticação ou CSRF.

Somente no GET identificado:

1. O wrapper no ponto da sessão executa o limitador antes de inicializar sessão, Shield ou autenticação. Nenhum store é construído, consultado ou confirmado.
2. Em seguida executa uma nova instância de Shield com cópia da configuração e apenas CSRF desativado para essa requisição. A configuração compartilhada permanece intacta. HSTS, X-Frame-Options e nosniff continuam funcionando, inclusive em 429.
3. As etapas seguintes dispensam a inicialização original de Shield, auth e silent auth apenas nessa mesma identidade. Não há leitura/renovação da sessão mesmo se o cliente enviar um cookie administrativo válido.
4. O ponto de rate limiting da rota reconhece o GET já limitado e não o executa novamente. HEAD, que o Adonis associa à rota GET, continua com o fluxo original e seu limitador no ponto original.

Os retornos 200, 422, 429 e 503 do GET não enviam Set-Cookie nem acessam o store de sessão. O rate limiter mantém seu contador em memória por IP; “sem estado” aqui significa ausência de estado de sessão/autenticação, não ausência do contador de proteção contra abuso.

A exceção não abrange HEAD, POST, PUT, PATCH, DELETE, rotas administrativas, `/api/services`, `/api/csrf` ou URLs semelhantes que correspondam a outra rota. **HEAD e outras rotas mantêm inclusive os efeitos de sessão do fluxo legado**; esta correção não promete torná-los sem estado. Autenticação e CSRF em escritas continuam obrigatórios como antes.

As regressões instrumentam o SessionMiddleware original com um store que realmente persiste na tabela `sessions` do SQLite isolado. Para os quatro status públicos, verificam zero construções, leituras, escritas, touch e destroy, tabela vazia, ausência de cookies e presença dos headers de segurança. Também verificam login/logout, cookie administrativo válido, PATCH autenticado com CSRF, rejeição de escritas sem CSRF, fluxo legado de HEAD e independência das outras rotas. Nenhuma instrumentação existe no caminho de produção.

## Rate limiting

Limite próprio de **60 requisições por IP a cada janela de 60 segundos**, iniciada na primeira consulta daquele IP. Conta consultas válidas e inválidas, antes de sessão/Shield, validação ou acesso ao calendário nesse GET. A 61ª e seguintes retornam 429 com Retry-After em segundos e no-store.

Reutiliza o mecanismo em memória existente, com namespace availability-ip separado. O limite de cadastro de clientes continua 20/minuto e não foi reutilizado. Rotas administrativas, catálogo e demais APIs não recebem esse middleware nem consomem seu orçamento. Um administrador consultando a rota pública está sujeito ao mesmo limite público.

A identificação usa request.ip() do Adonis, respeitando TRUST_PROXY. O middleware não lê diretamente X-Forwarded-For, X-Real-IP ou outro header para escolher IP. Em produção, configurar TRUST_PROXY somente para proxies conhecidos que controlem os headers encaminhados; não usar wildcard/trust-all. O teste usa o Request real do Adonis com peer não confiável e confirma que headers arbitrários não alteram o orçamento.

Limitações intencionais do mecanismo existente:

- O contador vive em cada processo, reinicia com ele e não é compartilhado entre instâncias.
- Pessoas atrás do mesmo NAT/proxy podem compartilhar limite; trocar o IP real pode obter outro orçamento. Não substitui proteção de borda contra ataques distribuídos.
- As entradas de IPs do Map existente não são expurgadas automaticamente quando deixam de ser usadas; muitos IPs distintos podem aumentar o uso de memória. Não houve refatoração global do limitador nesta etapa.
- Para escala maior, será necessário revisar retenção/limites de memória e adotar armazenamento compartilhado ou limitação na borda. Não foram adicionadas dependências, CAPTCHA ou autenticação.

Não são publicados IP, nome de instância, estratégia de armazenamento ou contadores de infraestrutura em headers. Além dos headers existentes da aplicação, esta rota usa somente no-store e Retry-After quando limitada.

## Códigos HTTP

| Código | Significado |
| --- | --- |
| 200 | Consulta válida, mesmo com slots vazio |
| 422 | `{ "message": "Informe uma única data válida no formato YYYY-MM-DD." }` |
| 429 | `{ "message": "Muitas consultas. Aguarde antes de tentar novamente." }`, com Retry-After |
| 503 | `{ "message": "Não foi possível consultar os horários. Tente novamente." }`, sem detalhes internos |

Todos os retornos do endpoint usam JSON e no-store, inclusive com Accept HTML. O rate limiting pode retornar 429 antes da validação, quando o orçamento estiver esgotado.

## Consumo pelo futuro frontend

Consultar novamente ao selecionar uma data e atualizar a lista com a resposta mais recente. Preferir uma chamada por seleção efetiva e evitar polling excessivo. Não enviar cookies ou CSRF é suficiente para acesso anônimo; se o cliente compartilhado usa credentials: include, isso continua compatível.

Exibir horários locais no fuso informado, sem parse de startsAtLocal como UTC. Para 422, corrigir entrada; para 429, respeitar Retry-After; para 503, oferecer nova tentativa. Não armazenar a resposta como garantia de vaga nem apresentar confirmação de agendamento.

**A disponibilidade é informativa: ainda não considera reservas, não constitui reserva e não garante vaga.** Na futura confirmação, o frontend deverá tratar conflitos e recarregar horários. A API de reservas revalidará serviço ativo, calendário e ocupação dentro de transação protegida e constraint de unicidade. Essa criação de reservas não existe nesta PR.

## Verificação

```bash
npm test -- unit
npm test -- functional
npm run lint
npm run build
```

Os testes novos usam o serviço real e SQLite isolado, com relógio injetado pelo container; não dependem da data atual para calcular disponibilidade. Cobrem acesso sem sessão/CSRF, resultados, fechamentos, pausas/bloqueios/liberações, passado/mesmo dia, bissexto, query estrita, JSON/no-store, privacidade, ausência de gravação de configuração, integração com APIs administrativas reais, orçamento/429 e independência dos outros endpoints. O teste de peer não confiável usa factories existentes do Adonis, sem dependências novas. As novas regressões de sessão usam store instrumentado persistido em SQLite isolado e cobrem os retornos 200/422/429/503, headers, cookies, métodos distintos e preservação administrativa/CSRF.

Todas as suítes anteriores são preservadas. A validação completa ocorre em cópia descartável; nenhuma migration é executada no banco de desenvolvimento. Sem frontend, reservas, tabelas novas, notificações, pagamentos ou autenticação de clientes.
