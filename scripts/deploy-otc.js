const hre = require("hardhat");

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer signer found. Set DEPLOYER_PRIVATE_KEY in .env.");
  }

  const owner = requiredEnv("OTC_OWNER_ADDRESS");
  const keeper = requiredEnv("OTC_KEEPER_ADDRESS");

  console.log(`Network: ${hre.network.name}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Owner: ${owner}`);
  console.log(`Keeper: ${keeper}`);

  console.log("");

  if (hre.network.name === "axon") {
    const AxonEscrow = await hre.ethers.getContractFactory("AxonCrossChainEscrow");
    const axonEscrow = await AxonEscrow.deploy(owner, keeper);
    await axonEscrow.waitForDeployment();
    const axonEscrowAddress = await axonEscrow.getAddress();

    const cancelCooldown = process.env.OTC_CANCEL_COOLDOWN_SECONDS;
    if (cancelCooldown) {
      const tx = await axonEscrow.setCancelCooldown(BigInt(cancelCooldown));
      await tx.wait();
    }

    console.log("Axon deployment complete");
    console.log(`OTC_AXON_ESCROW_ADDRESS=${axonEscrowAddress}`);
    return;
  }

  if (hre.network.name === "bsc") {
    const PaymentFactory = await hre.ethers.getContractFactory("BscPaymentVaultFactory");
    const paymentFactory = await PaymentFactory.deploy(owner, keeper);
    await paymentFactory.waitForDeployment();
    const paymentFactoryAddress = await paymentFactory.getAddress();

    console.log("BSC deployment complete");
    console.log(`OTC_BSC_PAYMENT_FACTORY_ADDRESS=${paymentFactoryAddress}`);
    return;
  }

  throw new Error(`Unsupported network '${hre.network.name}'. Use --network axon or --network bsc.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
