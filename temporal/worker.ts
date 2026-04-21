import "dotenv/config";
import { Worker, NativeConnection } from "@temporalio/worker";
import * as activities from "./activities";
import { MAX_CONCURRENT } from "../shared";

const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE || "agatha-github";
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || "localhost:7233";
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE || "default";

async function run(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: TEMPORAL_ADDRESS,
  });

  const worker = await Worker.create({
    connection,
    namespace: TEMPORAL_NAMESPACE,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve("./workflows"),
    activities,
    maxConcurrentActivityTaskExecutions: MAX_CONCURRENT,
  });

  console.log(
    `Temporal worker started — queue "${TASK_QUEUE}", namespace "${TEMPORAL_NAMESPACE}", max ${MAX_CONCURRENT} concurrent activities`
  );

  await worker.run();
}

run().catch((err) => {
  console.error("Temporal worker failed:", err);
  process.exit(1);
});
