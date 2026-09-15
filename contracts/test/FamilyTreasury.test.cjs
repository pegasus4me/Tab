const { expect } = require("chai");
const { ethers } = require("hardhat");
const usdc = (amount) => ethers.parseUnits(String(amount), 6);

describe("FamilyTreasury", function () {
  async function deployFixture() {
    const [alice, bob, leo, merchant, stranger] = await ethers.getSigners();
    const asset = await ethers.deployContract("MockUSDC");
    const configs = [["Household", 0, 1], ["Emergency", usdc(1000), 2], ["Wedding", 0, 2], ["Travel", 0, 1]];
    const treasury = await ethers.deployContract("FamilyTreasury", [asset.target, [alice.address, bob.address], configs]);
    await asset.mint(alice.address, usdc(5000));
    await asset.connect(alice).approve(treasury.target, usdc(5000));
    await treasury.connect(alice).deposit(usdc(5000));
    return { asset, treasury, alice, bob, leo, merchant, stranger };
  }
  it("creates one discoverable treasury per family", async function () {
    const [alice, bob] = await ethers.getSigners(); const asset = await ethers.deployContract("MockUSDC"); const factory = await ethers.deployContract("FamilyTreasuryFactory", [asset.target]); const id = ethers.id("martin-family");
    await factory.connect(alice).createFamily(id, [alice.address, bob.address], [["Emergency", 0, 2]]);
    expect(await factory.treasuryForFamily(id)).to.not.equal(ethers.ZeroAddress);
    await expect(factory.connect(alice).createFamily(id, [alice.address], [["Duplicate", 0, 1]])).to.be.revertedWithCustomError(factory, "FamilyAlreadyExists");
  });
  it("applies a confirmed plan atomically", async function () {
    const { treasury, alice } = await deployFixture(); await treasury.connect(alice).allocate([0, 1, 2, 3], [usdc(1800), usdc(1200), usdc(900), usdc(200)]);
    expect((await treasury.vault(1)).balance).to.equal(usdc(1200)); expect(await treasury.unallocatedBalance()).to.equal(usdc(900));
  });
  it("enforces the emergency floor and wedding quorum", async function () {
    const { asset, treasury, alice, bob, merchant } = await deployFixture(); await treasury.connect(alice).allocate([1, 2], [usdc(1200), usdc(900)]);
    await expect(treasury.connect(alice).proposeWithdrawal(1, merchant.address, usdc(300))).to.be.revertedWithCustomError(treasury, "WouldBreachVaultFloor");
    await treasury.connect(alice).proposeWithdrawal(2, merchant.address, usdc(400)); expect((await treasury.withdrawal(0)).executed).to.equal(false); await treasury.connect(bob).approveWithdrawal(0); expect(await asset.balanceOf(merchant.address)).to.equal(usdc(400));
  });
  it("executes a parent-approved recurring transfer to an internal vault", async function () {
    const { treasury, alice } = await deployFixture(); await treasury.connect(alice).allocate([0], [usdc(1000)]);
    const firstExecutionAt = Number((await ethers.provider.getBlock("latest")).timestamp) + 60;
    await treasury.connect(alice).proposeScheduledTransfer(0, 3, ethers.ZeroAddress, usdc(300), 30 * 24 * 60 * 60, firstExecutionAt);
    await ethers.provider.send("evm_increaseTime", [60]); await ethers.provider.send("evm_mine");
    await treasury.executeScheduledTransfer(0); expect((await treasury.vault(3)).balance).to.equal(usdc(300));
    await expect(treasury.executeScheduledTransfer(0)).to.be.revertedWithCustomError(treasury, "ScheduleNotDue");
  });
  it("requires both parents before a recurring payment to Mamie becomes active", async function () {
    const { asset, treasury, alice, bob, leo } = await deployFixture(); await treasury.connect(alice).allocate([2], [usdc(900)]);
    const firstExecutionAt = Number((await ethers.provider.getBlock("latest")).timestamp) + 60;
    await treasury.connect(alice).proposeScheduledTransfer(2, 4294967295, leo.address, usdc(300), 7 * 24 * 60 * 60, firstExecutionAt);
    await expect(treasury.executeScheduledTransfer(0)).to.be.revertedWithCustomError(treasury, "ScheduleNotActive");
    await treasury.connect(bob).approveScheduledTransfer(0); await ethers.provider.send("evm_increaseTime", [60]); await ethers.provider.send("evm_mine"); await treasury.executeScheduledTransfer(0); expect(await asset.balanceOf(leo.address)).to.equal(usdc(300));
  });
  it("never grants an outsider authority", async function () { const { treasury, stranger } = await deployFixture(); await expect(treasury.connect(stranger).allocate([0], [usdc(1)])).to.be.revertedWithCustomError(treasury, "NotParent"); });
  it("lets an existing owner grant full treasury permissions to a family member", async function () {
    const { treasury, alice, leo, stranger } = await deployFixture();
    await expect(treasury.connect(stranger).addOwner(leo.address)).to.be.revertedWithCustomError(treasury, "NotParent");
    await treasury.connect(alice).addOwner(leo.address);
    expect(await treasury.isParent(leo.address)).to.equal(true);
    expect(await treasury.parents()).to.include(leo.address);
    await treasury.connect(leo).createVault(["Leo's goal", 0, 1]);
  });
});

describe("FamilyTreasury live lifecycle regressions", function () {
  it("rechecks the protected floor when the final parent approves a stale proposal", async function () {
    const [alice, bob, recipient] = await ethers.getSigners();
    const asset = await ethers.deployContract("MockUSDC");
    const treasury = await ethers.deployContract("FamilyTreasury", [asset.target, [alice.address, bob.address], [["Reserve", usdc(1000), 2]]]);
    await asset.mint(alice.address, usdc(1400));
    await asset.connect(alice).approve(treasury.target, usdc(1400));
    await treasury.connect(alice).deposit(usdc(1400));
    await treasury.connect(alice).allocate([0], [usdc(1400)]);
    await treasury.connect(alice).proposeWithdrawal(0, recipient.address, usdc(300));
    await treasury.connect(alice).proposeWithdrawal(0, recipient.address, usdc(300));
    await treasury.connect(bob).approveWithdrawal(0);
    await expect(treasury.connect(bob).approveWithdrawal(1)).to.be.revertedWithCustomError(treasury, "WouldBreachVaultFloor");
    expect((await treasury.vault(0)).balance).to.equal(usdc(1100));
    expect((await treasury.withdrawal(1)).executed).to.equal(false);
  });
  it("creates a real vault and restricts creation to a parent", async function () {
    const [alice, stranger] = await ethers.getSigners();
    const asset = await ethers.deployContract("MockUSDC");
    const treasury = await ethers.deployContract("FamilyTreasury", [asset.target, [alice.address], [["Everyday", 0, 1]]]);
    await expect(treasury.connect(stranger).createVault(["Holiday", 0, 1])).to.be.revertedWithCustomError(treasury, "NotParent");
    await treasury.connect(alice).createVault(["Holiday", 0, 1]);
    expect(await treasury.vaultCount()).to.equal(2);
    expect((await treasury.vault(1)).name).to.equal("Holiday");
  });
});
