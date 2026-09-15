const { ethers, network } = require("hardhat");

async function main() {
  const addressesByNetwork = {
    monadTestnet: process.env.USDC_ADDRESS_TESTNET,
    monadMainnet: process.env.USDC_ADDRESS_MAINNET,
  };
  const usdcAddress = addressesByNetwork[network.name];
  if (!ethers.isAddress(usdcAddress)) throw new Error(`Set the USDC address for ${network.name} in contracts/.env.`);
  const factory = await ethers.deployContract("ActivityEscrowFactory", [usdcAddress]);
  await factory.waitForDeployment();
  console.log(`ActivityEscrowFactory deployed at ${factory.target}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
