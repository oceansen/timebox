# Timebox

Run a timed agenda and show the live activity on a big screen.

- Build projects as a list of timed activities.
- Start, pause, stop, reset, and scrub to any point in the timeline.
- "Show on big screen" opens a full-screen stage with the current activity, its countdown, what's next, and optional spoken announcements.
- Everyone with the link sees the same timer live (Server-Sent Events). Changing anything needs the control PIN.

## Run locally

```sh
npm install
CONTROL_PIN=1234 npm start   # http://localhost:3000
```

Without `DATABASE_URL`, data is kept in `data/timebox.json`.

## Environment

| Variable | Purpose |
|---|---|
| `CONTROL_PIN` | PIN required to control or edit. Leave unset to allow anyone. |
| `DATABASE_URL` | Postgres connection string. Data is stored in table `timebox_docs`. |
| `PORT` | Set by Render. |

On first start with an empty store, the SCT Impact Workshop plan is added.
