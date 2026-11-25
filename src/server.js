import { createApp } from "./app.js";
import { createPool } from "./db.js";

const pool = createPool();
const { app } = await createApp(pool);
const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(`UPI Offline Mesh (simulation) listening on :${port}`));
