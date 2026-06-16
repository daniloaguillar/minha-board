# Minha Board

App de desktop (Windows) para anotações e tarefas num quadro estilo Milanote — notas em papel pautado, pastas, folhas de desenho, múltiplas boards, zoom/pan e tudo salvo localmente no computador, com backups automáticos.

Feito com Electron. As notas de cada usuário ficam em `Documentos\Minha Board` e **nunca** saem do PC.

## Recursos

- Notas com tarefas (checklists), títulos e reordenação por arraste
- Pastas coloridas, folhas de desenho e desenho livre sobre a board
- Múltiplas boards (abas) e transferência de itens entre elas
- Zoom/pan estilo Milanote e "ver board completo"
- Auto-organizar, Concluídos, Lixeira e temas claro/escuro
- Backup (exportar/importar, cópia automática em pasta de nuvem)
- **Atualização automática** via GitHub Releases

## Desenvolvimento

```bash
npm install
npm start
```

## Gerar instalador e publicar uma atualização

1. Aumente a `version` no `package.json` (ex.: `1.0.1`).
2. Rode:

```bash
npm run release
```

Isso gera o instalador para Windows e publica uma nova *release* neste repositório.
Os usuários recebem a atualização automaticamente na próxima vez que abrirem o app.

> Requer a variável de ambiente `GH_TOKEN` com um token do GitHub com permissão de escrita neste repositório.
