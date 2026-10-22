
import dns from "node:dns";
import mongoose from "mongoose";
import { DB_URI, NODE_ENV } from "../config/env.js";

// OPTIONAL DNS override for mongodb+srv:// lookups. Some local networks refuse
// the SRV query Node issues (querySrv ECONNREFUSED) even though the same lookup
// works through a public resolver. Set e.g. DNS_SERVERS=8.8.8.8,1.1.1.1 in the
// local env file to use those resolvers. Unset (the deployed default) -> the
// system resolver is used exactly as before.
const DNS_SERVERS = String(process.env.DNS_SERVERS || "")
  .split(",")
  .map((server) => server.trim())
  .filter(Boolean);
if (DNS_SERVERS.length) dns.setServers(DNS_SERVERS);

if(!DB_URI) {
  throw new Error("DB_URI is not defined in environment variables or .env<development/production>.local file.");
}

const connectToDatabase = async () => {
    try {
        // await mongoose.connect(DB_URI, {
        //     useNewUrlParser: true,
        //     useUnifiedTopology: true,
        // });
        await mongoose.connect(DB_URI);
        console.log(`Connected to ${NODE_ENV} env MongoDB successfully!!`);
    }catch (error) {
        console.error("Error connecting to MongoDB:", error);
        process.exit(1); // Exit the process with failure
    }
}

export default connectToDatabase;