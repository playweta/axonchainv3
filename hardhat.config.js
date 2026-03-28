require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");

const accounts = process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [];

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  networks: {
    hardhat: {},
    axon: {
      url: process.env.AXON_RPC_URL || "",
      chainId: Number(process.env.AXON_CHAIN_ID || 8210),
      accounts
    },
    bsc: {
      url: process.env.BSC_RPC_URL || "",
      chainId: Number(process.env.BSC_CHAIN_ID || 56),
      accounts
    }
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  }
};
