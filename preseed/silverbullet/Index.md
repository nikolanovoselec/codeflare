This is your Codeflare vault. Notes here persist across sessions and feed the cross-session memory that your AI agent uses to remember decisions, code references, and prior conversations.

New to this? Read [[README]] for what the vault is, why it exists, and how to use SilverBullet. <!-- dashboard-readme-link -->

> _First-load tip: Codeflare prepares the browser-side Vault index before the Vault button enables. Once it opens, SilverBullet should already have its IndexedDB cache ready._

# Notes and references
<!-- dashboard-notes-references -->

- [[Notes]] — durable notes saved when you ask the agent to take a note.
- [[References]] — source material and references you want to keep close.

${(function()
  local ok, r = pcall(function() return query[[
    from p = index.contentPages()
    where (p.name == "Notes" or p.name:startsWith("Notes/")
      or p.name == "References" or p.name:startsWith("References/"))
    order by p.lastModified desc
    limit 12
    select templates.fullPageItem(p)
  ]] end)
  if not ok then return "_Indexing your notes and references, reload in a few seconds..._" end
  return r
end)()}

# Recent quick notes
${(function() local ok, r = pcall(function() return widgets.commandButton("Quick Note") end); return ok and r or "" end)()}

${(function()
  local ok, r = pcall(function() return some(query[[
    from p = tags.page
    where p.name:startsWith("Inbox/")
    order by p.lastModified desc
    limit 10 select templates.fullPageItem(p)
  ]]) end)
  if not ok then return "_Indexing your vault, reload in a few seconds..._" end
  return r or "_No quick notes yet. Use the button above to capture one._"
end)()}

# Recent journal entries
${(function() local ok, r = pcall(function() return widgets.commandButton("Journal: Today") end); return ok and r or "" end)()}

${(function()
  local ok, r = pcall(function() return some(query[[
    from j = index.tag(config.get("journal.tag"))
    where j.tag == "page"
    order by j.date desc
    limit 14
    select templates.pageItem(j)
  ]]) end)
  if not ok then return "_Indexing your vault, reload in a few seconds..._" end
  return r or "_No journal entries yet. Start one with the button above._"
end)()}

# Recent incomplete tasks
${(function()
  local ok, r = pcall(function() return some(query[[
    from t = tags.task
    where not t.done
    order by t.pageLastModified
    desc limit 10
    select templates.taskItem(t)
  ]]) end)
  if not ok then return "_Indexing your vault, reload in a few seconds..._" end
  return r or "_All tasks done!_"
end)()}

# Recently modified pages
${(function()
  local ok, r = pcall(function() return query[[
    from p = index.contentPages()
    where p.name != "Index" and p.name != "CONFIG"
      and p.name != "README" and p.name != "STYLES"
    order by p.lastModified desc
    limit 10
    select templates.fullPageItem(p)
  ]] end)
  if not ok then return "_Indexing your vault, reload in a few seconds..._" end
  return r
end)()}
