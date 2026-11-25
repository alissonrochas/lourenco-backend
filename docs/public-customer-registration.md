# Privacidade do cadastro público de clientes

## Risco e decisão

`POST /api/customers` é público. Diferenciar telefone novo (201) de telefone existente (409) permite testar se alguém está cadastrado na barbearia. Retornar o modelo completo também divulga campos internos, como ID, `phoneNormalized` e datas. O rate limiting reduz a escala das consultas, mas não elimina essa enumeração.

A [orientação da OWASP sobre respostas genéricas e enumeração](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#authentication-and-error-messages) recomenda considerar mensagem, código HTTP e diferenças de processamento também no cadastro.

Para uma entrada válida e dentro dos limites, o contrato público agora é sempre:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
```

```json
{"message":"Solicitação recebida."}
```

O corpo não inclui cliente, ID, nome, telefone, telefone normalizado, datas, token ou indicação de criação/duplicidade. Não é enviado um header `Location` apontando para o cliente. O mesmo contrato vale para novo cadastro, telefone equivalente existente e conflito de unicidade causado por concorrência. A confirmação é de recebimento da solicitação; não confirma identidade, propriedade do telefone ou agendamento.

Validação de entrada continua retornando 422; CSRF inválido, 403; excesso de requisições, 429 com `Retry-After`. Essas decisões não dependem de o telefone estar cadastrado. Erros inesperados de persistência continuam sendo propagados ao tratamento de exceções; não são convertidos indiscriminadamente em sucesso.

## Integridade e titularidade

- Telefones novos continuam normalizados e protegidos pelos índices únicos existentes.
- Um cadastro repetido não altera nome, telefone, normalização ou datas do cliente existente.
- A violação de unicidade só recebe a resposta genérica quando se confirma um registro com o mesmo telefone normalizado ou com o valor exato no índice original de `phone`.
- Registros antigos com `phoneNormalized = NULL` são preservados, inclusive se o índice original de `phone` impedir uma nova inserção. Este endpoint não saneia nem associa automaticamente registros antigos.
- A listagem de clientes permanece restrita à gestão, com a autorização atual.

Clientes não precisam receber contas ou senhas para o futuro fluxo de agendamento. Entretanto, informar um número não comprova sua titularidade. Uma integração futura deverá tratar a associação no servidor e definir a autorização adequada para consultar, alterar ou cancelar dados e reservas. Nunca deve usar apenas o telefone ou um ID retornado pelo cadastro como autorização. Nenhum agendamento, mecanismo de verificação de telefone ou modelo de autenticação foi implementado nesta mudança.

## Limites e compatibilidade

A resposta uniforme remove a distinção explícita por status, corpo e headers de recurso. Ela não oferece garantia de tempo constante: consultar um registro e inserir dados têm custos diferentes, portanto diferenças estatísticas de tempo continuam sendo um risco residual. Não foram adicionados atrasos artificiais. Permanecem o rate limiting em memória, suas limitações de múltiplas instâncias e a necessidade de configurar `TRUST_PROXY` corretamente, conforme [reverse-proxy.md](reverse-proxy.md).

Este contrato substitui a antiga resposta com o objeto do cliente. O frontend atual lê `payload.name` na mensagem de sucesso e precisará passar a apresentar a mensagem genérica; esse ajuste de interface está fora deste commit exclusivo do backend. A resposta não deve voltar a expor o cliente para manter essa compatibilidade.

## Verificação

Os testes funcionais verificam igualdade exata da resposta pública, novos e antigos telefones equivalentes, ausência de localização do recurso, preservação integral dos dados existentes, tentativas de substituir campos internos, registros antigos sem normalização e submissões concorrentes. Também mantêm as verificações de CSRF, rate limiting, listagem administrativa e sessão existentes. Os testes da migration real pelo Lucid continuam preservados.

A suíte é executada em cópia isolada do backend, com SQLite temporário, sem alterar o banco de desenvolvimento.
