# Configuração conservadora de proxy reverso

O rate limiting usa `ctx.request.ip()` do AdonisJS.

Por padrão, o projeto usa `TRUST_PROXY=loopback`. Nesse modo, o servidor só aceita endereços de proxy de loopback para forwarded headers. Não confie em `X-Forwarded-For` enviado diretamente por clientes da internet.

## Quando houver proxy reverso

Defina `TRUST_PROXY` como o endereço ou faixa de proxies realmente confiáveis. Exemplos:

- `TRUST_PROXY=127.0.0.1`
- `TRUST_PROXY=loopback,127.0.0.1` pode não ser necessário; use apenas o formato aceito pelo `proxy-addr` da versão instalada.
- Para múltiplos proxies conhecidos, use uma configuração CIDR/IP validada pelo `proxy-addr`.

No proxy, sobrescreva os headers de encaminhamento. Nunca permita que o cliente defina seus próprios valores sem serem substituídos pelo proxy.

O proxy deve executar a substituição de pelo menos:

- `X-Forwarded-For`
- `X-Forwarded-Proto`
- `X-Forwarded-Host`

## Limitação atual

Sem proxy configurado, o backend deve continuar usando o IP da conexão direta. Isso pode agrupar usuários quando estiver atrás de NAT ou balanceador não informado ao servidor.

O rate limiter atual é em memória e é reiniciado ao reiniciar o processo. Para múltiplas instâncias, será necessário um store compartilhado em etapa posterior.
