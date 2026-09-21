# Jive

> Rethinking the Agentic Loop with System One Models

I have been thinking that the current Agentic Loop design of LLM Call -> Tool Call -> ... has been outdated. The arrival of Jev and other System One models provided us a primitive we desperately needed. We need an agent that can natively think fast and slow. Not have workflows or multi-agent architectures that mimics it.

The agent should be able to do its hard reasoning using the power of modern LLMs, capture an execution graph filled with steps and fast intuitive decisions, and prevent it from making LLM calls for just to "follow through the plan". 

![The same task as a regular coding agent's linear trace and as a Jive graph trace](docs/assets/trace-comparison.gif)

> [Interactive version](docs/assets/trace-comparison.html): the same task as a regular agent's linear LLM → tool → LLM chain and as one Jive planner call whose graph runs bash nodes, Jev decisions, a foreach fan-out and bounded repeat loops. Open the file in a browser to watch the LLM-call and reasoning-token counters diverge.

**Jive** replaces "Tool Calls" with "Graph Calls", where each graph is a DAG-based workflow compromising of Tool Calls and Jev Calls. The agent can do bulk evaluation / analysis of datasets, multi-step profiling, repetitive tasks very efficiently with System One decisions sprinkled in between. 

> benchmark results with demo videos

It is generally not a good idea to fight against a models training, and there are certain tasks that codex, claude code or your favorite agent is better for. **BUT:**
- I argue it is already extremely useful in certain usecases, and surprisingly more efficient with on par quality on most daily tasks of an engineer.
- There is a direct corrolation with the intelligence index of a model, and how effectively it can utilize jive. As the models get better, and System One Models get better, and we slowly get into the training set, the gap will be undeniable
- It is a great core to improve e2e latency and cost for a lot of enterprise usecases like customer support, targeted assistants for lawyers, internal analytics agents etc. without compromising on quality. 

So screw it, I'm fighting the models training. 

**Let's welcome Agent 2.0**

I know its a bold statement. I'm not sure if this is it. But I know its a step in the right direction.

## Documentation

- [Overview and getting started](docs/README.md): what Jive is, installation, quick start, project configuration, command line, development
- [Using Jive](docs/USAGE.md): interface, sessions, headless commands, skills, extractors
- [Graph contract](docs/GRAPH_CONTRACT.md): the graph language the planner writes
- [Planner context](docs/CONTEXT.md): planner context, compaction, and Jev input limits
- [Design](DESIGN.md): architecture and confirmed design decisions
- [Taskground](taskground/README.md), and the [planner evaluation guide](evals/planner/README.md)


- [Contributing](CONTRIBUTING.md)
  - You can test jive on certain tasks easily using the taskground. If you do, please contribute your task to the repo so we can build a shared open-source dataset together. 

## License

[MIT](LICENSE)
