# API administrativa de funcionamento semanal

Esta etapa expõe somente `GET` e `PATCH /api/admin/booking-settings`. Reutiliza os quatro models de [booking-schedule-model.md](booking-schedule-model.md) e segue [booking-mvp-plan.md](booking-mvp-plan.md). Sem migrations novas, reservas, disponibilidade pública ou frontend.

## Segurança e respostas

Ambas as rotas pertencem ao grupo protegido pelo `adminAuth`: sessão existente e papel administrativo atual são obrigatórios. PATCH mantém o CSRF global; GET não exige cookie/header XSRF. O frontend deve manter `credentials: 'include'`, preparar CSRF para PATCH e tratar sessão expirada. Não há autenticação paralela.

Respostas do controller usam JSON e `Cache-Control: no-store`, inclusive validações e conflitos. O transformer permite somente campos do contrato abaixo, sem IDs internos, timestamps, dados de usuário, cliente ou sessão. A autenticação e os erros de CSRF continuam nos mecanismos existentes.

| Status | Situação | Corpo |
| --- | --- | --- |
| 200 | Leitura ou atualização válida | `{ "data": { ... } }` |
| 401 | Sem sessão | Mensagem do adminAuth existente |
| 403 | Papel administrativo revogado ou CSRF inválido | Mensagem do adminAuth ou handler CSRF existente (`E_BAD_CSRF_TOKEN`) |
| 422 | Payload, campos ou configuração resultante inválidos | `{ "message": "Configuração semanal inválida." }` |
| 409 | Constraint, integridade ou contenção SQLite | `{ "message": "Conflito ao salvar a configuração. Recarregue e tente novamente." }` |

Os erros tratados não expõem SQL, detalhes de constraints ou stack traces. Accept HTML não transforma esses erros em páginas Inertia.

## GET: sete dias, sem efeitos de escrita

A leitura sempre retorna sete dias em ordem ISO, segunda (1) a domingo (7). Dias ausentes são representados como fechados e não configurados. `isConfigured` indica que ambos os horários estão definidos; um dia pode estar configurado e inativo. Nenhum horário é inventado.

Sem registros, a resposta completa é:

```json
{
  "data": {
    "timezone": "America/Sao_Paulo",
    "slotDurationMinutes": 60,
    "days": [
      {
        "weekday": 1,
        "isConfigured": false,
        "isActive": false,
        "opensAtMinute": null,
        "closesAtMinute": null,
        "breaks": [],
        "slotBlocks": []
      },
      {
        "weekday": 2,
        "isConfigured": false,
        "isActive": false,
        "opensAtMinute": null,
        "closesAtMinute": null,
        "breaks": [],
        "slotBlocks": []
      },
      {
        "weekday": 3,
        "isConfigured": false,
        "isActive": false,
        "opensAtMinute": null,
        "closesAtMinute": null,
        "breaks": [],
        "slotBlocks": []
      },
      {
        "weekday": 4,
        "isConfigured": false,
        "isActive": false,
        "opensAtMinute": null,
        "closesAtMinute": null,
        "breaks": [],
        "slotBlocks": []
      },
      {
        "weekday": 5,
        "isConfigured": false,
        "isActive": false,
        "opensAtMinute": null,
        "closesAtMinute": null,
        "breaks": [],
        "slotBlocks": []
      },
      {
        "weekday": 6,
        "isConfigured": false,
        "isActive": false,
        "opensAtMinute": null,
        "closesAtMinute": null,
        "breaks": [],
        "slotBlocks": []
      },
      {
        "weekday": 7,
        "isConfigured": false,
        "isActive": false,
        "opensAtMinute": null,
        "closesAtMinute": null,
        "breaks": [],
        "slotBlocks": []
      }
    ]
  }
}
```

A ausência da configuração global usa os valores fixos aprovados apenas na representação, sem inserir registros. O GET executa suas consultas em uma transação de leitura para evitar misturar versões dos dias e filhos; não cria nem modifica dados. Após configuração, cada `breaks` contém `{ "startsAtMinute": 720, "endsAtMinute": 780, "isActive": true }`, e cada `slotBlocks` contém `{ "startsAtMinute": 600, "isBlocked": true }`. As listas são ordenadas pelo minuto inicial e incluem registros inativos/liberados preservados.

## PATCH: atualização atômica dos dias enviados

Exemplo completo de entrada para configurar segunda e manter domingo fechado (são exemplos, não defaults):

```json
{
  "days": [
    {
      "weekday": 1,
      "isActive": true,
      "opensAtMinute": 540,
      "closesAtMinute": 1080,
      "breaks": [
        { "startsAtMinute": 720, "endsAtMinute": 780, "isActive": true }
      ],
      "slotBlocks": [
        { "startsAtMinute": 600, "isBlocked": true }
      ]
    },
    { "weekday": 7, "isActive": false }
  ]
}
```

Retorna 200 com a mesma estrutura completa do GET, incluindo os sete dias. A configuração global 1 é criada deterministicamente no primeiro PATCH válido, com defaults do banco (America/Sao_Paulo e 60). Nada é inicializado se a transação falhar.

### Campos e omissões

- `days` é obrigatório: array de 1 a 7 dias, sem weekday repetido. Dias omitidos permanecem exatamente como estavam.
- Cada dia exige `weekday` e pelo menos um de `isActive`, `opensAtMinute`, `closesAtMinute`, `breaks` ou `slotBlocks`. Enviar somente weekday ou campos desconhecidos é inválido.
- Propriedades omitidas do dia preservam os valores atuais. Um dia novo começa inativo, sem horários; para ativá-lo, envie um par válido, ou use o par que já estiver persistido.
- `isActive: false` fecha o dia sem apagar horários, pausas ou bloqueios. Reativar exige revalidar o conjunto preservado. Um dia fechado não terá disponibilidade futura, mesmo que possua pausas e bloqueios ativos.
- Apenas abertura e fechamento aceitam null. Para limpar horários, ambos devem resultar em null, o dia deve estar inativo e não pode haver pausas ativas ou blocos bloqueados. É necessário desativá-los explicitamente, se existirem. Um único horário nulo é inválido.
- Envio válido que já coincide com os dados atuais retorna 200, sem forçar alteração de timestamps. Payload vazio/sem campos editáveis recebe 422.

### Listas de pausas e bloqueios

Listas **omitidas** permanecem intactas. Listas **enviadas** representam o conjunto desejado para aquele dia. Cada item deve informar todos os seus campos de negócio; não existem IDs editáveis.

A identidade de uma pausa ou bloqueio é `(weekday, startsAtMinute)`. Reenviar o mesmo início preserva o ID e createdAt, permitindo editar o fim/status da pausa ou o status do bloqueio. Mudar o início cria um registro para o novo início e desativa/libera o anterior, que permanece no histórico da configuração.

Itens anteriores ausentes da lista enviada são marcados `isActive: false` ou `isBlocked: false`, sem DELETE. `breaks: []` desativa todas as pausas do dia; `slotBlocks: []` libera todos esses bloqueios. Um item já existente pode ser reativado/rebloqueado pelo mesmo início. A resposta continua incluindo itens inativos/liberados; não interpretar presença como disponibilidade ou bloqueio ativo.

Exemplo para fechar segunda sem perder sua configuração:

```json
{ "days": [{ "weekday": 1, "isActive": false }] }
```

Exemplo para liberar o bloqueio de 10:00 (os demais bloqueios da lista omitidos também serão liberados):

```json
{
  "days": [{ "weekday": 1, "slotBlocks": [
    { "startsAtMinute": 600, "isBlocked": false }
  ] }]
}
```

Liberar esse bloqueio não abre o dia, não remove pausa, nem poderá ignorar futuras reservas ou exceções por data. Esse endpoint configura regras; não calcula horários disponíveis.

## Validação da configuração resultante

VineJS valida tipos JSON estritos, estrutura e whitelist, usando somente o corpo da requisição. Não aceita strings no lugar de números/booleanos, null em status/listas, campos extras em nenhum nível, timezone, duração do bloco, IDs, FKs ou timestamps. `isConfigured` é apenas de leitura e também não deve ser reenviado.

- Dias ISO inteiros 1–7, sem duplicatas.
- Abertura inteira 0–1380 e fechamento inteiro 60–1440, em múltiplos de 60, abertura < fechamento. Não há funcionamento atravessando meia-noite; 1440 é apenas o limite final do dia. Blocos completos cabem nesse intervalo.
- Pausas: início/fim inteiros em horas cheias, início < fim, campos startsAtMinute, endsAtMinute e isActive obrigatórios. Até 24 itens por lista; mesmo início repetido é rejeitado, inclusive se inativo. Pausas ativas não podem se sobrepor; intervalos adjacentes são permitidos e pausas inativas podem se sobrepor.
- Bloqueios: início inteiro em hora cheia de 0 a 1380, com o bloco inteiro de 60 minutos dentro do funcionamento. startsAtMinute e isBlocked obrigatórios. Até 24 itens, sem início repetido.
- Todos os filhos explicitamente enviados precisam caber nos horários resultantes, mesmo se inativos/liberados. Filhos históricos inativos/liberados são preservados quando horários encolhem, sem impedir a edição; eles não geram indisponibilidade.
- Filhos ativos/bloqueados preservados por omissão também são validados. Reduzir o funcionamento de modo que exclua uma pausa ativa ou bloco bloqueado recebe 422, a menos que a mesma requisição os desative/libere pelo conjunto enviado.
- Nenhuma combinação de um dia válido com outro inválido é gravada parcialmente.

## Persistência, concorrência e timestamps

Toda gravação e a releitura da resposta ocorrem na mesma transação Lucid, com os quatro models existentes e atribuição explícita de campos permitidos. Não há exclusão de registros. Lucid atualiza updatedAt quando há mudanças, preservando IDs e createdAt; dados sem mudanças não recebem atualização artificial.

A primeira instrução da transação de escrita é um UPDATE da chave global para ela mesma, inclusive quando a tabela está vazia. No SQLite isso adquire a trava de escrita **antes** das leituras da configuração, sem mudar valores de negócio ou timestamps. Só depois são lidos os dias/filhos, validadas as regras e gravadas as mudanças. Esse mecanismo não depende de mutex em memória e funciona entre processos que compartilham o mesmo banco.

Outra escrita aguarda conforme o timeout do driver ou recebe erro de contenção mapeado para 409. Não há retry automático; após 409 o painel deve recarregar e permitir nova tentativa. A API não possui versionamento otimista: duas alterações válidas podem ser aplicadas sequencialmente, com a última substituindo os campos/listas que enviou. O objetivo desta etapa é manter integridade e atomicidade; uma futura exigência de detectar edições desatualizadas requer contrato de versão próprio.

O GET usa snapshot transacional, sem escrita. CHECKs, UNIQUE e FKs continuam como segunda camada de integridade. Falhas de gravação revertem também a inicialização global e alterações de dias anteriores do mesmo payload.

## Consumo pelo futuro painel

1. Consultar GET com sessão; apresentar os sete dias e distinguir fechado de não configurado.
2. Editar valores em minutos inteiros, exibindo horas locais. Abertura/fechamento não vêm de constantes do frontend.
3. Enviar somente dias e propriedades alterados. Quando editar uma lista, enviar seu conjunto desejado completo, incluindo estados que queira manter; itens omitidos serão desativados/liberados.
4. Construir o payload por whitelist, sem copiar diretamente a resposta GET, pois isConfigured é de leitura. Filtrar históricos inativos fora do novo funcionamento se não houver intenção de reativá-los; não reenviá-los como novos itens inválidos.
5. Usar a preparação CSRF compartilhada para PATCH e cookies de sessão; em 401/403 aplicar o fluxo administrativo existente. Em 422 conservar a edição e solicitar correção; em 409 recarregar para reconciliar alterações.
6. Após 200, substituir o estado local pela resposta completa, inclusive registros preservados inativos/liberados. Nunca anunciar agendamento confirmado a partir desta API.

## Limitações e próximas etapas

Um barbeiro e uma agenda, fuso e blocos fixos, sem reservas ou calendário excepcional. Não existe disponibilidade pública nesta PR. Não foram criados horizonte de reserva, antecedência mínima ou autenticação de clientes.

**Antes de habilitar reservas públicas**, a verificação de conflitos com reservas confirmadas deverá integrar esta transação de configuração e a de criação de reservas. Seguir o plano: rejeitar mudanças conflitantes e exigir resolução administrativa explícita/auditada, nunca cancelar ou mover silenciosamente reservas existentes. Liberar horários deverá respeitar também a ocupação e as futuras exceções por data.

## Testes locais

```bash
npm test -- unit
npm test -- functional
npm run lint
npm run build
```

Usar exclusivamente o SQLite isolado já configurado; o bootstrap aplica/reverte migrations em memória. Testes de contenção usam duas conexões independentes a um arquivo SQLite temporário, verificando inclusive a trava antes da criação do singleton. A validação desta etapa também roda em cópia descartável do backend, sem executar migrations no banco de desenvolvimento.

A cobertura inclui sessão/papel revogado, CSRF, GET vazio sem escrita, sete dias, edição/omissão, status, pausas, blocos, limites/tipos/duplicatas, null, whitelist/privacidade, timestamps/idempotência, rollback de múltiplos dias, conflitos de integridade sem vazamento e concorrência. As suítes anteriores continuam como regressão.
