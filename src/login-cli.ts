#!/usr/bin/env node

import { interactiveLogin } from "./login.js";

interactiveLogin()
  .then(() => {
    console.log("You can now start the MCP server with npm start.");
  })
  .catch((error) => {
    console.error("Login failed:", (error as Error).message);
    process.exit(1);
  });
