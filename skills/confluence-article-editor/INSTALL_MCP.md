# Как настроить MCP для Confluence

Чтобы агент мог скачивать и загружать статьи Confluence, нужен MCP-сервер `mcp-atlassian`.

## 1. Выпустите токены

- Confluence: https://wiki.cloud.ru/plugins/personalaccesstokens/usertokens.action
- Jira: https://jira.cloud.ru/secure/ViewProfile.jspa?selectedTab=com.atlassian.pats.pats-plugin:jira-user-personal-access-tokens

Скопируйте токены сразу после создания: позже они могут быть недоступны для просмотра.

## 2. Добавьте MCP в `opencode.json`

Вставьте блок в конфиг OpenCode и замените значения в угловых скобках на свои токены:

```json
{
  "mcp": {
    "atlassian": {
      "type": "local",
      "command": ["uvx", "mcp-atlassian", "--transport", "stdio", "-vv"],
      "environment": {
        "CONFLUENCE_URL": "https://wiki.cloud.ru",
        "CONFLUENCE_PERSONAL_TOKEN": "<wiki_api_key>",
        "JIRA_URL": "https://jira.cloud.ru",
        "JIRA_PERSONAL_TOKEN": "<jira_api_key>",
        "CONFLUENCE_SPACES_FILTER": "OCP",
        "JIRA_PROJECTS_FILTER": "EVODP"
      },
      "enabled": true
    }
  }
}
```

Если Jira не нужна, всё равно оставьте блок как есть, если ваш `mcp-atlassian` требует обе переменные.

## 3. Перезапустите OpenCode

После изменения `opencode.json` перезапустите OpenCode, чтобы MCP-сервер подхватился.

## 4. Если не работает

Проверьте:

- `enabled` должен быть `true`.
- Токены не должны быть пустыми или протухшими.
- У пользователя должны быть права на нужный Confluence space и страницу.
- `CONFLUENCE_SPACES_FILTER` должен включать space, где находится статья.
