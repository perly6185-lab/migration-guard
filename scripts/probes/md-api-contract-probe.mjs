import path from "node:path";
import { pathToFileURL } from "node:url";

const targetRoot = process.env.MD_TARGET_ROOT || process.cwd();

function targetModule(relativePath) {
  return pathToFileURL(path.join(targetRoot, relativePath)).href;
}

function createEnv() {
  return {
    APP_URL: "https://md.example.com,http://localhost:5173,https://*--doocs-md.netlify.app",
    GITHUB_CLIENT_ID: "probe-client-id",
    GITHUB_CLIENT_SECRET: "probe-client-secret",
    JWT_SECRET: "probe-secret",
    UPLOAD_ENABLED: "false",
    ASSETS: {
      fetch: async () => new Response("asset", { status: 200 })
    },
    DB: {
      prepare() {
        throw new Error("DB access is outside this contract probe");
      }
    }
  };
}

async function readJson(response) {
  try {
    return await response.clone().json();
  } catch {
    return undefined;
  }
}

async function exchange(app, name, input, init) {
  const response = await app.request(input, init, createEnv());
  const json = await readJson(response);
  return {
    name,
    status: response.status,
    ok: response.ok,
    corsOrigin: response.headers.get("access-control-allow-origin") || null,
    corsCredentials: response.headers.get("access-control-allow-credentials") || null,
    contentType: response.headers.get("content-type")?.split(";")[0] || null,
    json
  };
}

const { default: app } = await import(targetModule("apps/api/src/index.ts"));

const exchanges = [
  await exchange(app, "root-health", "https://api.example.test/", {
    headers: {
      Origin: "https://md.example.com"
    }
  }),
  await exchange(app, "cors-preflight-upload", "https://api.example.test/upload", {
    method: "OPTIONS",
    headers: {
      Origin: "https://md.example.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type"
    }
  }),
  await exchange(app, "upload-disabled", "https://api.example.test/upload", {
    method: "POST",
    headers: {
      Origin: "https://md.example.com"
    }
  }),
  await exchange(app, "me-unauthorized", "https://api.example.test/me", {
    headers: {
      Origin: "https://md.example.com"
    }
  })
];

const expectations = {
  rootHealthOk: exchanges.find(item => item.name === "root-health")?.json?.ok === true,
  rootHealthName: exchanges.find(item => item.name === "root-health")?.json?.name === "md-api",
  allowedCorsEchoed: exchanges.every(item => item.corsOrigin === null || item.corsOrigin === "https://md.example.com"),
  uploadDisabledStatus: exchanges.find(item => item.name === "upload-disabled")?.status === 404,
  uploadDisabledError: exchanges.find(item => item.name === "upload-disabled")?.json?.error === "upload_disabled",
  meUnauthorizedStatus: exchanges.find(item => item.name === "me-unauthorized")?.status === 401,
  meUnauthorizedError: exchanges.find(item => item.name === "me-unauthorized")?.json?.error === "unauthorized"
};

const result = {
  api: {
    exchanges: exchanges.map(item => ({
      name: item.name,
      status: item.status,
      ok: item.ok,
      corsOrigin: item.corsOrigin,
      corsCredentials: item.corsCredentials,
      contentType: item.contentType,
      json: item.json
    })),
    expectations
  }
};

console.log(JSON.stringify(result));

if (Object.values(expectations).some(value => value !== true)) {
  process.exitCode = 1;
}
