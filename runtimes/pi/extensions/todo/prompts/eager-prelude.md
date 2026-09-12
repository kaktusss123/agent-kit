Consider calling `todo` first to lay out a phased plan with a single `init` op. A good list covers the whole request — investigation through implementation and verification — not just the next step, with specific task descriptions a future turn could execute without re-planning.
A useful list keeps each task to a concise, specific 5-10 word label; the `init` op only accepts phase names and task-label strings, so don't invent extra task metadata fields.
If you create the list, continue the request in the same turn and avoid re-calling `todo` unless task state materially changes.
