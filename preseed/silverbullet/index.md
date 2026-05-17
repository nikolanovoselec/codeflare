This is your codeflare vault. Notes here persist across sessions and feed the cross-session memory that your AI agent uses to remember decisions, code references, and prior conversations.

New to this? Read [[README]] for what the vault is, why it exists, and how to use SilverBullet.

> _First-load tip: on a fresh session the widget buttons and query lists below appear empty for ~30 seconds while SilverBullet federates its standard library from `silverbullet.md`. Refresh once if buttons don't react._

# Recent quick notes
${widgets.commandButton "Quick Note"}

${some(query[[
  from p = tags.page
  where p.name:startsWith("Inbox/")
  order by p.lastModified desc
  limit 10 select templates.fullPageItem(p)
]]) or "_No quick notes yet. Use the button above to capture one._"}

# Recent journal entries
${widgets.commandButton "Journal: Today"}

${some(query[[
  from j = index.tag(config.get("journal.tag"))
  where j.tag == "page"
  order by j.date desc
  limit 14
  select templates.pageItem(j)
]]) or "_No journal entries yet. Start one with the button above._"}

# Recent incomplete tasks
${some(query[[
  from t = tags.task
  where not t.done
  order by t.pageLastModified
  desc limit 10
  select templates.taskItem(t)
]]) or "_All tasks done!_"}

# Recently modified pages
${query[[
  from p = index.contentPages()
  where p.name != "index" and p.name != "CONFIG"
    and p.name != "README" and p.name != "STYLES"
  order by p.lastModified desc
  limit 10
  select templates.fullPageItem(p) 
]]}
