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

Não há escrita de configuração, criação de clientes, persistência de disponibilidade ou cache do resultado. As consultas usam o snapshot do serviço existente. Alterações administrativas passam a afetar consultas seguintes automaticamente, sem reconstrução de cache. Os middlewares de segurança/sessão existentes permanecem em uso; o endpoint não exige sessão ou token XSRF.

A resposta JSON não contém motivos administrativos, IDs de configuração, clientes, sessões, tokens, timestamps internos ou detalhes do banco. Razões de fechamento também não são publicadas; slots vazio é suficiente. Erros inesperados são registrados no servidor e convertidos em mensagem pública genérica, sem stack/SQL na resposta.

## Rate limiting

Limite próprio de **60 requisições por IP a cada janela de 60 segundos**, iniciada na primeira consulta daquele IP. Conta consultas válidas e inválidas, antes da validação ou acesso ao calendário. A 61ª e seguintes retornam 429 com Retry-After em segundos e no-store.

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

Os testes novos usam o serviço real e SQLite isolado, com relógio injetado pelo container; não dependem da data atual para calcular disponibilidade. Cobrem acesso sem sessão/CSRF, resultados, fechamentos, pausas/bloqueios/liberações, passado/mesmo dia, bissexto, query estrita, JSON/no-store, privacidade, ausência de gravação de configuração, integração com APIs administrativas reais, orçamento/429 e independência dos outros endpoints. O teste de peer não confiável usa factories existentes do Adonis, sem dependências novas.

Todas as suítes anteriores são preservadas. A validação completa ocorre em cópia descartável; nenhuma migration é executada no banco de desenvolvimento. Sem frontend, reservas, tabelas novas, notificações, pagamentos ou autenticação de clientes.
