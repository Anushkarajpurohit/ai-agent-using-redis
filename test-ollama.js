const BASE_URL =
  process.env.OLLAMA_BASE_URL ||
  "https://ollama-u2gx-production.up.railway.app";

const MODEL = process.env.OLLAMA_MODEL || "gemma3:1b";

async function test() {
  console.log("Testing Ollama...");
  console.log("Base URL:", BASE_URL);
  console.log("Model:", MODEL);

  try {
    // Check server
    const tagsRes = await fetch(`${BASE_URL}/api/tags`);

    console.log("\n/api/tags:", tagsRes.status);

    const tags = await tagsRes.json();
    console.log(JSON.stringify(tags, null, 2));

    // Generate a response
    console.log("\nGenerating response...\n");

    const genRes = await fetch(`${BASE_URL}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        prompt: "Reply with exactly: Railway Ollama is working.",
        stream: false,
      }),
    });

    console.log("/api/generate:", genRes.status);

    const result = await genRes.json();
    console.log("\nResponse:");
    console.log(result.response);
  } catch (err) {
    console.error("\nConnection failed:");
    console.error(err);
  }
}

test();