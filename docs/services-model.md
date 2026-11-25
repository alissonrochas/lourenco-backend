# Serviços — estrutura de dados e model

Esta primeira etapa adiciona somente a tabela `services`, o model `Service`, o schema gerado e testes. Não há controllers, endpoints, validators de API, frontend ou agendamentos novos.

## Campos e integridade

| Banco | Model | Decisão |
| --- | --- | --- |
| `id` | `id` | Chave primária inteira autoincrementada |
| `name` | `name` | Obrigatório; `CHECK` rejeita texto vazio ou composto apenas por espaços |
| `description` | `description` | Texto opcional, `NULL` quando omitido |
| `price_cents` | `priceCents` | Inteiro não negativo em centavos |
| `duration_minutes` | `durationMinutes` | Inteiro entre 5 e 480, inclusive |
| `is_active` | `isActive` | Não nulo, padrão ativo; somente 0/1 no SQLite |
| `created_at` | `createdAt` | Não nulo, preenchido automaticamente pelo Lucid |
| `updated_at` | `updatedAt` | Automático na criação/atualização pelo model; anulável no banco, seguindo `Customer` |

R$ 45,00 é armazenado como `4500`, sem cálculo monetário em ponto flutuante. O preço tem limite técnico de `9007199254740991` centavos (`Number.MAX_SAFE_INTEGER`) para manter a representação exata em JavaScript; nenhum teto comercial adicional foi definido. Preço zero é permitido. Valores negativos, fracionários, não numéricos ou fora desse limite são rejeitados no banco.

As restrições utilizam `typeof(...)` porque a afinidade de uma coluna SQLite, sozinha, não garante que o valor armazenado seja inteiro. Elas validam a representação persistida: por exemplo, SQLite pode converter texto numérico em inteiro antes de verificar o `CHECK`. Validação de tipos JSON e mensagens para usuários pertencem à futura camada de API.

Durações como 45 minutos são permitidas; não existe restrição a múltiplos de 30. O status usa `boolean` na migration e um `consume` no model para transformar o 0/1 retornado pelo SQLite em `false`/`true`, inclusive na serialização do model.

`Service` segue o padrão direto de `Customer`, estendendo `BaseModel` e usando decorators de coluna e `DateTime` do Luxon. O Lucid mapeia camelCase para snake_case. O arquivo `database/schema.ts` é atualizado pelo gerador em uma cópia temporária, sem aplicar migrations no banco de desenvolvimento.

Não há unicidade de nome, normalização automática de descrição, relacionamentos ou exclusão lógica adicional nesta etapa. Alterar `isActive` preserva o registro. Os timestamps automáticos são responsabilidade do model; inserções SQL diretas devem informar `created_at`.

## Migration

`1795564800000_create_services_table.ts` é aditiva: cria exclusivamente `services`. A reversão remove somente essa tabela e, consequentemente, seus serviços. Clientes, usuários e sessões não são alterados. Não há backfill nem seed de dados reais.

Não execute a migration contra o banco local apenas para rodar os testes desta etapa. A aplicação operacional dessa migration deverá ocorrer posteriormente, de forma deliberada, com a revisão e o backup apropriados.

## Testes

Os testes de serviços usam `MigrationRunner` real com um novo SQLite em diretório temporário por teste. Primeiro executam as cinco migrations existentes e inserem fixtures fictícias de clientes, usuários e sessões; depois tornam a migration de serviços disponível como lote separado. Não criam manualmente a tabela de serviços.

A cobertura inclui:

- Aplicação, reversão e reaplicação reais da migration.
- Preservação de registros, definições de tabelas e índices existentes.
- Chave primária, campos opcionais e padrão ativo.
- Preço zero, inteiro seguro máximo e rejeição de preços inválidos, inclusive em atualização SQL direta.
- Limites 5/480 e duração de 45 minutos; rejeição de valores fora da faixa ou fracionários.
- Domínio booleano 0/1, nome obrigatório e timestamp de criação obrigatório.
- Persistência pelo model, mapeamento de campos, serialização booleana, edição, ativação/desativação e timestamps automáticos.

Todas as operações do model usam uma transação explícita da conexão temporária (`{ client: transaction }`), incluindo leitura e atualização. O adapter global e a conexão padrão da aplicação não são substituídos. As transações são revertidas e os diretórios temporários removidos ao final.

A validação completa deve ser feita em uma cópia isolada do backend, pois os testes funcionais preexistentes utilizam a conexão padrão da aplicação. Nessa cópia, crie um `.env` exclusivamente de teste, prepare um SQLite descartável, execute as migrations e os comandos:

```bash
npm test -- unit
npm test -- functional
npm run lint
npm run build
```

O gerador pode reformatar `UserSchema`; a validação de lint deve usar o schema gerado com a formatação do projeto, sem introduzir mudanças cosméticas nas classes anteriores. Ambientes reais, bancos locais, `package-lock.json` modificado e a declaração local `types/better_sqlite3.d.ts` ficam fora desta alteração.

Referências: [migrations do Lucid](https://lucid.adonisjs.com/docs/migrations), [CHECKs do Knex](https://knexjs.org/guide/schema-builder#check) e [tipos no SQLite](https://sqlite.org/datatype3.html).
