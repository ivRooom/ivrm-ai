import { InMemoryUsageStore } from "./memory-store.js";
import { usageStoreContract } from "./store-contract.js";

usageStoreContract("in-memory", async () => new InMemoryUsageStore());
