import { InMemoryChatStore } from "./memory-store.js";
import { chatStoreContract } from "./store-contract.js";

chatStoreContract("in-memory", async () => new InMemoryChatStore());
