const { ethers } = require("hardhat");

async function main() {
  const addressesByNetwork = {
    monadTestnet: process.env.USDC_ADDRESS_TESTNET,
    monadMainnet: process.env.USDC_ADDRESS_MAINNET,
  };
  const usdcAddress = addressesByNetwork[hre.network.name];
  if (!ethers.isAddress(usdcAddress)) {
    throw new Error(`Set the USDC address for ${hre.network.name} in contracts/.env.`);
  }

  const factory = await ethers.deployContract("FamilyTreasuryFactory", [usdcAddress]);
  await factory.waitForDeployment();
  console.log(`FamilyTreasuryFactory deployed at ${factory.target}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
