# Claude Account Manager (`cam`)

[![CI](https://github.com/caiquepessan/claude-account-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/caiquepessan/claude-account-manager/actions/workflows/ci.yml)
[![licença](https://img.shields.io/github/license/caiquepessan/claude-account-manager)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518.17-brightgreen)](https://nodejs.org)
[![dependências](https://img.shields.io/badge/dependencies-zero-brightgreen)](package.json)

Escolha com qual conta Claude o `claude` inicia.

English: [README.md](README.md)

```
PS C:\proj\api> claude

╭──────────────────────────────────────────────────────────────────────╮
│ Claude Account Manager  0.1.0                    claude 2.1.252      │
│ ──────────────────────────────────────────────────────────────────── │
│   ○ default      voce@gmail.com · max             seu login       1  │
│ ▸ ● work         eu@acme.io · team · Acme Inc     2h atrás        2  │
│   ○ research     lab@uni.edu · pro                ! expira em 4d  3  │
│                                                                      │
│   + Adicionar conta                   via claude auth login       a  │
│ ──────────────────────────────────────────────────────────────────── │
│ ↑↓ mover · ↵ iniciar · a adicionar · q sair                          │
╰──────────────────────────────────────────────────────────────────────╯

● = ativa (pré-selecionada)   ○ = parada   ▸ = cursor   ! = precisa de atenção
```

Ao apertar `↵` a caixa é apagada; sobra uma linha no histórico do terminal e o
Claude Code de verdade assume:

```
PS C:\proj\api> claude
✓ work · eu@acme.io · team

╭───────────────────────────────────────────╮
│ ✻ Welcome to Claude Code                  │
╰───────────────────────────────────────────╯
```

Apertar `2` faz a mesma coisa em uma tecla só: o dígito pula para a linha e já
inicia. A ordem das linhas é estável — `default` primeiro, depois a ordem de
criação — então os dígitos nunca mudam de lugar embaixo dos seus dedos.

> Sem afiliação com a Anthropic, e sem endosso ou patrocínio dela.

## Por quê

O Claude Code guarda um login só. Se você tem uma conta pessoal e uma de
trabalho, ou uma conta por cliente, a única forma suportada de alternar é sair e
entrar de novo. Isso perde a sessão em que você estava e é lento o bastante para
as pessoas simplesmente pararem de fazer — e mandarem o prompt errado para a
organização errada.

O `cam` dá a cada conta a sua própria pasta e deixa você escolher uma na hora de
iniciar. Nada é desconectado. Nada é copiado de uma conta para outra. A conta que
você já usa continua funcionando exatamente como hoje, com o nome `default`.

## Instalação

```sh
npm i -g @caiquepessan/claude-account-manager
```

Isso instala dois comandos, `cam` e o apelido mais longo
`claude-account-manager`. São o mesmo programa.

Requisitos: Node.js 18.17 ou mais novo e o Claude Code já instalado. O `cam` não
tem nenhuma dependência em tempo de execução — só módulos nativos do Node.

Depois, para o `claude` sozinho perguntar qual conta usar:

```sh
cam shell install
```

## Primeiros passos

```sh
cam doctor         # antes de tudo, checar cada suposição nesta máquina
cam add            # entrar com uma segunda conta
cam shell install  # fazer o `claude` sozinho perguntar
claude             # escolher uma conta e iniciar o Claude Code
```

O `cam add` pede um nome, prova que duas pastas de configuração são de fato
isoladas nesta máquina, cria a pasta e entrega o terminal ao `claude auth login`
do próprio Claude Code. O `cam` nunca vê a sua senha.

```
╭─ Adicionar uma conta ────────────────────────────────────────────────╮
│ Dê um nome a esta conta                                              │
│   ›  client-acme▏                                                    │
│      a–z 0–9 . _ -  ·  máx 32  ·  isso vira um nome de pasta         │
╰──────────────────────────────────────────────────────────────────────╯
  ↵ continuar · esc cancelar

✓ Teste de isolamento  uma pasta nova reporta que está deslogada
✓ Pasta                ~/.claude-account-manager/profiles/client-acme
✓ Herdado              onboarding, tema, confiança de pasta, 3 MCP servers
✓ Compartilhado        plugins, commands, agents, skills   (junction)
·  Não compartilhado   histórico de conversas e sessões do --resume ficam
                       privados de cada conta, de propósito

───────────────────────── claude auth login ──────────────────────────
Login successful.
──────────────────────────────────────────────────────────────────────

✓ Conectado           billing@corp.example · Corp Ltd · team
✓ Salvo como "client-acme"
```

Se o login for cancelado ou falhar, o perfil pela metade é removido e nada mais
muda. Para guardá-lo e investigar, use `cam add <nome> --keep`.

## Comandos

Do dia a dia:

| Comando | O que faz |
| --- | --- |
| `cam add [nome]` | Entrar com outra conta. Opções: `--console`, `--sso`, `--email <endereço>`, `--no-share`, `--no-seed`, `--share-projects`, `--keep`. |
| `cam ls` | Listar contas, planos, organizações e validade do login. `--json` para saída de máquina. Apelido: `cam list`. |
| `cam use [nome]` | Definir a conta que o `claude` sozinho usa. Sem nome e com terminal, abre o menu. |
| `cam rm <nome>` | Colocar uma conta em quarentena, na pasta `trash/`. `--yes` pula a confirmação digitada, `--purge` apaga de vez em vez disso — sem desfazer, e no macOS apaga também o item do Keychain daquela conta. |
| `cam shell install\|uninstall\|status` | Instalar, remover ou inspecionar o hook do `claude` no shell. `--dry-run` mostra o que mudaria, `--shell <id>` limita a um shell. |
| `cam doctor` | Checar cada suposição nesta máquina. `--deep` refaz o teste de isolamento, `--fix` aplica os reparos marcados como seguros, `--json` para saída de máquina. |
| `cam help [comando]` | Ajuda. `--all` também lista os comandos avançados. |

Avançados (`cam help --all`):

| Comando | O que faz |
| --- | --- |
| `cam launch [-- <args...>]` | Escolher uma conta e iniciar o Claude Code. É o que o hook do shell chama. |
| `cam which [-v]` | Mostrar qual conta seria usada agora, e por quê. `--json` para saída de máquina. |
| `cam env <nome>` | Imprimir o ambiente de uma conta como comandos de shell. `--shell posix\|powershell\|fish\|cmd`. |
| `cam exec <nome> -- <cmd...>` | Rodar qualquer comando sob o ambiente de uma conta. |
| `cam restore <nome>` | Trazer de volta uma conta em quarentena. |
| `cam trash` | Listar a quarentena. `--empty` esvazia, `--yes` pula a confirmação. |
| `cam config [chave] [valor]` | Ler ou mudar as três configurações: `ask` (`auto\|always\|never`), `claudeBin` (caminho absoluto do binário `claude`), `ascii` (`true\|false`). |

Opções globais: `--cam <nome>`, `--keep-env`, `--ask <modo>`, `--json`,
`-y/--yes`, `-v/--verbose`, `--ascii`, `--no-color`, `--lang en|pt-BR`,
`-h/--help`, `--version`.

Os códigos de saída são estáveis e estão documentados no `cam help`:

```
0 OK   1 ERROR   2 USAGE   4 NOT_FOUND   5 CONFLICT
6 NO_ACCOUNTS   7 AUTH_FAILED   8 UNSAFE   127 NO_CLAUDE   130 CANCELLED
```

## Fazendo o `claude` perguntar

O `cam shell install` escreve um bloco gerenciado nos arquivos de inicialização
do seu shell. Ele define uma função chamada `claude` que chama o `cam launch` e
depois executa o binário `claude` de verdade — resolvido como executável, então a
função nunca chama a si mesma. PowerShell, bash, zsh e fish são suportados. O
`cmd.exe` não é: a única forma de instalar um hook nele é uma chave `AutoRun` no
registro, que afeta todo `cmd.exe` da máquina — invasivo demais. Ali, use
`cam env` ou `cam exec`.

A regra que o hook segue é de propósito bem estreita:

```sh
claude                          # pergunta — sem argumentos e com mais de uma conta
claude -p "resuma isso" | jq    # não pergunta; a saída padrão continua limpa
claude --resume                 # não pergunta; retoma dentro da conta ativa
claude --cam research -c        # troca pontual; o claude nunca vê o --cam
```

Qualquer argumento passado ao `claude` significa que você já sabe o que quer,
então o menu sai da frente. Integrações de IDE, scripts e CI se comportam
exatamente como antes de você instalar o `cam`. O menu é desenhado no **stderr**,
então a saída padrão em um pipe não é afetada.

Para mudar a política: `cam config ask always` (perguntar mesmo com argumentos)
ou `cam config ask never` (nunca perguntar). O `--ask <modo>` e a variável
`CAM_ASK` sobrescrevem por uma execução. O `--cam` sem valor força o menu uma vez.

Todas as teclas, e não existem outras:

```
↑  k  Ctrl+P .......... anterior  (dá a volta)
↓  j  Ctrl+N  Tab ..... próxima   (dá a volta)
Home / End ............ primeira / última
1 … 9 ................. pular para a conta E iniciar
↵  (CR ou LF) ......... iniciar o Claude Code com a conta destacada
a ..................... adicionar uma conta
q  Esc ................ sair sem iniciar                 saída 0
Ctrl+C  Ctrl+D ........ cancelar                         saída 130
```

Instalar o hook é opcional. `cam launch`, `cam exec` e `cam env` funcionam
sozinhos, e o `cam shell uninstall` tira o bloco de volta, deixando o resto de
cada arquivo byte a byte como estava.

## Como funciona

O Claude Code lê a variável `CLAUDE_CONFIG_DIR`; quando ela está definida, toda a
configuração dele — inclusive o `.claude.json` e o `.credentials.json` — passa a
morar dentro daquela pasta, e não na sua pasta pessoal. O `cam` dá a cada conta a
sua própria pasta em `~/.claude-account-manager/profiles/<nome>/` e define essa
única variável no único processo filho `claude` que ele inicia. A partir daí é o
próprio Claude Code que cuida das credenciais, dentro daquela pasta, exatamente
como sempre fez — então um token renovado no meio da sessão é gravado direto na
conta a que pertence, e não existe nenhuma cópia guardada em outro lugar para
ficar desatualizada. A conta reservada `default` é a exceção que torna isso
seguro de instalar: ela não tem pasta própria, então o `cam` **não** define
nenhum `CLAUDE_CONFIG_DIR` para ela e entrega ao processo filho o seu ambiente
completamente intocado — byte a byte o que você já tem hoje. Isso inclui um
`CLAUDE_CONFIG_DIR` que você mesmo tenha definido: o `cam` mantém e imprime
`respeitando seu CLAUDE_CONFIG_DIR` em vez de passar por cima. O `cam` nunca
escreve em `~/.claude.json`, `~/.claude/.claude.json` ou
`~/.claude/.credentials.json`, e não existe nele nenhum caminho de código que
abra um arquivo de credenciais para escrita.

Cinco variáveis silenciosamente valem mais que o `CLAUDE_CONFIG_DIR`. Se
ficassem no lugar, todo perfil resolveria para a mesma conta enquanto o `cam`
reportasse sucesso — então, ao iniciar uma conta gerenciada pelo `cam`, ele
remove cada uma daquele processo filho e imprime uma linha dizendo que removeu:
`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_SECURESTORAGE_CONFIG_DIR`,
`SELF_HOSTED_RUNNER_HOST_CONFIG_DIR`, `CLAUDE_CODE_ACCOUNT_UUID` e
`CLAUDE_CODE_ORGANIZATION_UUID`. Use `--keep-env` quando uma delas for justamente
a credencial que você quer. A conta `default` é de novo a exceção, e de
propósito: nada é removido dela, porque "intocado" é a promessa inteira. Se uma
dessas cinco estiver definida no seu shell, a `default` roda como *aquela*
credencial, e não como o seu login do `~/.claude`. Remova a variável, ou escolha
uma conta com nome, onde o `cam` garante a escolha.

## O que é compartilhado e o que não é

Um perfil novo começa vazio, o que significaria reaprovar cada plugin e reaceitar
cada diálogo de confiança de pasta. Por isso o `cam add` compartilha as partes do
`~/.claude` que pertencem a *você*, e se recusa a compartilhar as partes que
pertencem à organização de uma conta específica.

| O quê | Tratamento | Por quê |
| --- | --- | --- |
| `plugins/`, `commands/`, `agents/`, `skills/` | **Compartilhado** — junction no Windows, symlink no resto; se não der, vira cópia, e por último é pulado | São as suas ferramentas. Edite uma vez, todas as contas veem. |
| `settings.json`, `CLAUDE.md` | **Copiados uma vez**, na criação | Ponto de partida, não um vínculo vivo — depois cada conta pode divergir. |
| Estado da máquina: flag de onboarding, tema, confiança por pasta, `mcpServers` | **Herdado uma vez**, a partir de uma lista explícita de chaves permitidas | Para uma conta nova não perguntar de novo o que você já respondeu. |
| Estado da conta: `oauthAccount`, caches de uso e elegibilidade, caches de acesso a modelo | **Nunca copiado** | Pertence a uma conta só. Copiar contamina a interface e os caches. |
| `projects/`, `sessions/`, `todos/`, `file-history/`, `shell-snapshots/` | **Não compartilhado** | São transcrições de conversa. Compartilhar deixa o `--resume` de uma conta continuar uma sessão que é de outra organização. |

Dito sem rodeio: **depois de trocar de conta, "meu histórico sumiu" é o
comportamento esperado.** Cada conta tem a sua própria lista de `--resume`, e é
esse justamente o objetivo. Se você aceita o risco e quer as transcrições
compartilhadas mesmo assim, crie o perfil com `cam add <nome> --share-projects`;
o `cam` avisa na criação que o `--resume` pode então carregar a sessão de outra
conta.

O `cam add --no-share` pula por completo as pastas compartilhadas e os arquivos
copiados. O `cam add --no-seed` pula o estado de máquina herdado.

## Segurança

O detalhe completo, incluindo a lista exata de arquivos escritos e o modelo de
ameaça, está no [SECURITY.md](SECURITY.md). As três coisas que importam aqui:

- **O `cam` nunca lê nem escreve o valor de um token.** Não existe caminho de
  código que abra o `.credentials.json` para escrita. O que ele chega a ler de um
  é pouco e fixo: os dois carimbos de validade por trás do aviso "expira em 4d",
  o tipo de assinatura e a lista de escopos, se existe ou não um token de acesso,
  os nomes das chaves de primeiro nível inesperadas, e uma impressão SHA-256 de
  12 caracteres do token de renovação, usada para perceber que dois perfis são a
  mesma conta. Nenhum token vai para log nem é gravado em arquivo que o `cam`
  crie. (O tipo de assinatura *é* guardado, como o plano que aparece no `cam ls`,
  no `.cam-meta.json` do próprio perfil.)
- **As credenciais de cada conta ficam onde o Claude Code as coloca.** No Linux e
  no Windows, isso é um `.credentials.json` em texto puro dentro da pasta do
  perfil; no macOS, é o Keychain de login, com um nome por pasta de configuração.
  O `cam` não muda esse armazenamento e não consegue deixá-lo mais seguro do que
  o Claude Code deixa. No Windows o `chmod` não faz nada, então esses arquivos
  são protegidos apenas pela ACL NTFS do seu perfil de usuário — o `cam doctor`
  diz isso em vez de sugerir uma proteção que não existe.
- **Remover uma conta não encerra a sessão.** O `cam rm` move uma pasta local
  para `trash/`. A sessão continua válida do lado da Anthropic até você
  encerrá-la em claude.ai → Settings → Sessions. O `cam rm` avisa isso todas as
  vezes, e o `cam restore <nome>` desfaz a remoção. O `cam rm --purge` não move
  nada: ele apaga a pasta do perfil de vez e, no macOS, apaga também o item do
  Keychain daquele perfil, que o `cam restore` não tem como trazer de volta.
  Mesmo assim, não encerra a sessão.

Esta ferramenta serve para alternar entre contas que já são suas. Não é uma forma
de dividir uma conta com outras pessoas; isso vai contra os termos da Anthropic.

## Suporte por plataforma

**Windows e Linux estão verificados.** O mecanismo é exercitado nos dois: o
isolamento por `CLAUDE_CONFIG_DIR`, junctions e symlinks, o shim de função do
PowerShell e o hook de bash/zsh. A CI roda a suíte de testes no Ubuntu, macOS e
Windows, nas versões 18.17, 20, 22 e 24 do Node.

**O macOS é verificado em tempo de execução, não presumido.** No macOS o backend
de credenciais é o Keychain de login, não um arquivo, e o `cam` não tem como
afirmar a partir de uma suíte de testes que a separação por pasta de configuração
no Keychain se comporta como ele precisa. Então, em vez de afirmar, o `cam add`
prova isso na sua máquina antes de criar uma segunda conta: ele cria uma pasta de
configuração descartável, pergunta ao `claude auth status --json` o que ela
reporta, e só continua se a resposta for "deslogado". Se uma pasta em branco
alega estar conectada, o isolamento não vale, todas as contas dividiriam uma
credencial só e trocar de conta não faria nada enquanto parecesse funcionar — por
isso o `cam add` se recusa e sai com código 8, em vez de mentir para você. O
`cam doctor` roda a mesma checagem e guarda o resultado em cache; o
`cam doctor --deep` refaz.

Se você usa o `cam` no macOS, essa checagem é a garantia que você tem. Relatos de
uso real no macOS são bem-vindos.

## Perguntas frequentes

**Isso mexe no meu login atual?** Não. Ele vira a linha `default` do menu, e o
`cam` não acrescenta nenhum `CLAUDE_CONFIG_DIR` próprio nem muda mais nada no
ambiente — byte a byte o comportamento que você tinha antes de instalar o `cam`.
Se você já define `CLAUDE_CONFIG_DIR` por conta própria, a `default` continua
usando o seu; o `cam` avisa em vez de passar por cima.

**O `cam` vê a minha senha?** Não. Adicionar uma conta entrega o terminal ao
`claude auth login` do próprio Claude Code. O `cam` nunca lida com senha, nunca
segura um token e nunca fala com os servidores da Anthropic.

**Trocar de conta desconecta a outra?** Não. Cada conta guarda a própria sessão
na própria pasta. Entrar em uma nova não desconecta as que você já tem.

**Por que meu histórico de conversas sumiu depois de trocar?** Porque ele não foi
junto, de propósito. As transcrições ficam privadas de cada conta para o
`--resume` não atravessar a fronteira entre organizações. Veja
[O que é compartilhado e o que não é](#o-que-é-compartilhado-e-o-que-não-é).

**Deixa o `claude` mais lento?** Só quando ele pergunta. Com argumentos, ele
resolve uma conta e executa o binário de verdade; não há daemon, nem chamada de
rede, nem árvore de dependências para carregar.

**Dá para usar sem o hook do shell?** Dá. `cam launch`, `cam exec <nome> --
<cmd>` e `eval "$(cam env work)"` funcionam sozinhos.

**Dá para fixar uma conta para um terminal inteiro ou um job de CI?** Defina
`CAM_PROFILE` (ou `CAM_ACCOUNT`) com o nome da conta. O `--cam` ainda tem
prioridade por uma execução.

**Onde fica tudo?** Em `~/.claude-account-manager`. Dá para mudar a pasta inteira
com `CAM_HOME` — útil no Windows quando o `MAX_PATH` fica apertado, coisa que o
`cam doctor` avisa.

## Resolução de problemas

Comece pelo `cam doctor`. Ele checa o Node, o binário do `claude`, o isolamento,
o backend de credenciais, variáveis de ambiente presentes, suporte a links, a
capacidade do terminal, o tamanho dos caminhos, o hook do shell e a validade do
login de cada conta.

**O menu nunca aparece.** Em ordem de probabilidade:

- O hook não está instalado, ou o terminal é anterior à instalação. Rode
  `cam shell status` e abra um terminal novo.
- Um **alias** chamado `claude` está na frente da função. No bash e no zsh, um
  alias ganha de uma função com o mesmo nome, então o hook nunca roda. O
  `cam shell install` avisa sobre isso; resolva com `unalias claude` e tire a
  linha do seu arquivo de configuração.
- Você está dentro da ferramenta Bash do próprio Claude Code. A variável
  `CLAUDECODE=1` é definida em todo processo que o Claude Code inicia, e ali o
  menu é suprimido sem exceção — perguntar em um stdin que nunca vai entregar um
  byte é um travamento, não um caminho mais lento.
- Você passou argumentos. É por design: `claude -p …`, `claude -c` e
  `claude --resume` nunca perguntam. Use `claude --cam` para forçar o menu uma
  vez, ou `cam config ask always`.
- Você está no git-bash ou no mintty. Ali o Node não recebe um TTY, então o hook
  avisa ao `cam` que é um terminal (`CAM_TTY=1`) e o `cam` cai para um prompt
  numerado, sem nenhum ANSI. Isso é esperado; o Windows Terminal dá o menu
  completo.
- Alguma outra coisa não é um terminal (um pipe, um runner de CI). O `cam` diz
  qual conta usou e por quê, em vez de escolher em silêncio:

  ```
  $ echo oi | claude
  cam: usando "work" (última usada; o stdin não é um terminal)
       troque com: cam use <nome>   ou   claude --cam <nome>
  ```

**`Não encontrei o comando claude`** (saída 127). O `cam` imprime todos os
caminhos em que procurou, e essa lista é o diagnóstico. Se o Claude Code está em
um lugar incomum, aponte direto para ele:

```sh
cam config claudeBin "C:\caminho\para\claude.exe"
```

O `cam doctor` lista todos os caminhos candidatos.

**`CLAUDE_CODE_OAUTH_TOKEN` definida no ambiente.** Essa variável é um desvio
completo da autenticação: ela vale mais que qualquer conta, então, ao iniciar uma
conta gerenciada pelo `cam`, ele a remove da sessão que inicia e avisa que
removeu. Se ela for mesmo a credencial que você quer — em um job de CI, por
exemplo — use `--keep-env` (ou defina `CAM_KEEP_ENV=1`) e o `cam` avisa que a
escolha de conta não está sendo garantida. Ela nunca é removida em silêncio, e
nunca é removida do seu shell. A conta reservada `default` não é tocada de jeito
nenhum: com essa variável exportada, a `default` roda como a conta do token, e
não como o seu login do `~/.claude`. Remova a variável, ou escolha uma conta com
nome, se não é isso que você quer.

**`Não dá para adicionar uma segunda conta com segurança nesta máquina`**
(saída 8). Uma pasta de configuração descartável reportou que já está conectada,
ou seja, o isolamento não vale. A causa comum é a variável
`CLAUDE_SECURESTORAGE_CONFIG_DIR` estar definida. Remova-a e rode o `cam doctor`.

**A saída sai quebrada ou desalinhada.** `CAM_ASCII=1` (ou `--ascii`) força saída
7-bit para todo símbolo, separador, seta e reticência que o `cam` imprime — menu,
tabelas, linhas de status e linhas simples de resumo, tudo; `NO_COLOR=1` (ou
`--no-color`) tira a cor. O layout é idêntico dos dois jeitos. A cor continua
quando você dobra para ASCII, porque as duas opções são independentes.

A dobra é opt-in e nunca é disparada por redirecionamento: mandar o `cam ls` para
um arquivo preserva o UTF-8, então um e-mail ou nome de organização com acento
sobrevive. Só um terminal que declara não saber desenhar unicode dobra sozinho.

**Um `%VARIÁVEL%` no prompt chega expandido — só no Windows.** Se o seu Claude
Code foi instalado com `npm i -g`, o ponto de entrada é um `claude.cmd`, e um
`.cmd` só pode ser iniciado através do `cmd.exe`. O `cmd.exe` substitui `%NOME%`
por qualquer variável de ambiente que exista *antes* de o programa começar,
então `claude "estamos com 100%CPU% de carga"` chega com `%CPU%` já trocado.
Isso é comportamento documentado do `cmd.exe` e não tem escape na linha de
comando — `%%` só funciona dentro de um arquivo .bat —, então nenhuma
ferramenta consegue evitar por completo. Duas saídas: usar o instalador nativo,
cujo `claude.exe` é executado direto e nunca passa por shell, ou mandar o texto
pela entrada padrão (`… | claude -p -`) em vez de como argumento. Nomes que não
existem como variável passam intactos.

**Outra coisa.** O `cam which -v` mostra exatamente qual conta seria usada, por
quê, qual binário rodaria e a linha de comando completa — normalmente mais rápido
que adivinhar.

## Desinstalar

```sh
cam shell uninstall
npm uninstall -g @caiquepessan/claude-account-manager
rm -rf ~/.claude-account-manager      # opcional: apaga as contas extras
```

O `cam shell uninstall` remove o bloco gerenciado de todo arquivo de shell em que
escreveu, deixando o resto de cada arquivo byte a byte como estava. Antes de
mexer em um arquivo ele copia para `<arquivo>.cam-backup-<ISO>`, exatamente como
o `cam shell install` faz. Nada é restaurado *a partir* dessas cópias — elas
ficam ali para você ler ou desfazer na mão, uma por edição, e são suas para
apagar.

O seu login original do Claude Code fica intacto o tempo todo, porque ele nunca
saiu do lugar. Apagar o `~/.claude-account-manager` apaga as pastas de
configuração das *outras* contas, o que não encerra as sessões delas — encerre em
claude.ai → Settings → Sessions se quiser que sumam de vez.

## Contribuindo

Veja o [CONTRIBUTING.md](CONTRIBUTING.md). Em resumo: ESM, Node 18.17+, zero
dependências, só módulos `node:`. Tudo que depende do ambiente vem de um `ctx`
injetado, então nenhum arquivo em `src/` além do `ctx.js` toca em `process.env`,
`process.platform`, `process.stdout`, `os.homedir()`, `Date.now()` ou
`node:child_process`. Toda string voltada ao usuário passa pelo `ctx.t()`, com
entrada correspondente em `en` e em `pt-BR`.

```sh
git clone https://github.com/caiquepessan/claude-account-manager
cd claude-account-manager
node --test          # não há nada para instalar — esse é o ponto
```

Para testar uma cópia de trabalho sem tocar nas suas contas de verdade:

```sh
CAM_HOME=/tmp/cam-scratch node bin/cam.js ls
```

Relatos de bug e questões de segurança:
[issues](https://github.com/caiquepessan/claude-account-manager/issues) ·
[SECURITY.md](SECURITY.md).

## Licença

MIT © Caique Pessan. Veja o [LICENSE](LICENSE).
