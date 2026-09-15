const { expect } = require("chai");
const { ethers } = require("hardhat");

const usdc = (value) => ethers.parseUnits(String(value), 6);

describe("ActivityEscrow", function () {
  async function fixture(capacity = 2) {
    const [organizer, recipient, alice, bob, charlie, outsider] = await ethers.getSigners();
    const asset = await ethers.deployContract("MockUSDC");
    const factory = await ethers.deployContract("ActivityEscrowFactory", [asset.target]);
    const now = Number((await ethers.provider.getBlock("latest")).timestamp);
    const activityId = ethers.id("five-a-side-friday");
    const termsHash = ethers.id("fixed terms v1");
    const deadline = now + 3600;
    const start = now + 7200;
    const cutoff = now + 7000;
    await factory.connect(organizer).createActivity(activityId, recipient.address, usdc(20), capacity, deadline, start, cutoff, termsHash);
    const escrow = await ethers.getContractAt("ActivityEscrow", await factory.escrowForActivity(activityId));
    for (const participant of [alice, bob, charlie]) {
      await asset.mint(participant.address, usdc(100));
      await asset.connect(participant).approve(escrow.target, usdc(100));
    }
    return { asset, factory, escrow, organizer, recipient, alice, bob, charlie, outsider, activityId, deadline, cutoff };
  }

  async function signOffer(escrow, owner, placeId, expiry, nonce, designatedBuyer = ethers.ZeroAddress) {
    const network = await ethers.provider.getNetwork();
    return owner.signTypedData(
      { name: "Count Me In Activity", version: "1", chainId: network.chainId, verifyingContract: escrow.target },
      { ReplacementOffer: [
        { name: "placeId", type: "uint256" }, { name: "owner", type: "address" },
        { name: "price", type: "uint256" }, { name: "expiry", type: "uint256" },
        { name: "nonce", type: "uint256" }, { name: "designatedBuyer", type: "address" },
      ] },
      { placeId, owner: owner.address, price: usdc(20), expiry, nonce, designatedBuyer }
    );
  }

  it("deploys one immutable escrow per activity", async function () {
    const { factory, organizer, recipient, activityId } = await fixture();
    await expect(factory.connect(organizer).createActivity(activityId, recipient.address, usdc(20), 2, 10, 20, 20, ethers.id("other")))
      .to.be.revertedWithCustomError(factory, "ActivityAlreadyExists");
  });

  it("reaches the exact threshold atomically and rejects extra joins", async function () {
    const { asset, escrow, alice, bob, charlie } = await fixture();
    await escrow.connect(alice).join();
    await expect(escrow.connect(bob).join()).to.emit(escrow, "Ready").withArgs(2, usdc(40));
    expect(await escrow.state()).to.equal(1);
    expect(await asset.balanceOf(escrow.target)).to.equal(usdc(40));
    await expect(escrow.connect(charlie).join()).to.be.revertedWithCustomError(escrow, "InvalidState");
  });

  it("settles only a ready activity and only once", async function () {
    const { asset, escrow, recipient, alice, bob } = await fixture();
    await expect(escrow.settle()).to.be.revertedWithCustomError(escrow, "InvalidState");
    await escrow.connect(alice).join(); await escrow.connect(bob).join();
    await escrow.settle();
    expect(await asset.balanceOf(recipient.address)).to.equal(usdc(40));
    expect(await escrow.state()).to.equal(2);
    await expect(escrow.settle()).to.be.revertedWithCustomError(escrow, "InvalidState");
  });

  it("expires at the deadline and refunds each place once", async function () {
    const { asset, escrow, alice, deadline } = await fixture(3);
    await escrow.connect(alice).join();
    await ethers.provider.send("evm_setNextBlockTimestamp", [deadline]); await ethers.provider.send("evm_mine");
    await expect(escrow.connect(alice).join()).to.be.revertedWithCustomError(escrow, "FundingClosed");
    await escrow.expire();
    await escrow.refund(0);
    expect(await asset.balanceOf(alice.address)).to.equal(usdc(100));
    await expect(escrow.refund(0)).to.be.revertedWithCustomError(escrow, "AlreadyRefunded");
  });

  it("allows only the organizer to cancel while collecting", async function () {
    const { escrow, organizer, outsider, alice } = await fixture();
    await escrow.connect(alice).join();
    await expect(escrow.connect(outsider).cancel()).to.be.revertedWithCustomError(escrow, "NotOrganizer");
    await escrow.connect(organizer).cancel();
    expect(await escrow.state()).to.equal(4);
  });

  it("replaces a place atomically before and after settlement", async function () {
    const { asset, escrow, alice, bob, charlie, cutoff } = await fixture();
    await escrow.connect(alice).join(); await escrow.connect(bob).join();
    const signature = await signOffer(escrow, alice, 0, cutoff - 1, 0);
    await escrow.connect(charlie).replace(0, cutoff - 1, 0, ethers.ZeroAddress, signature);
    expect((await escrow.places(0)).owner).to.equal(charlie.address);
    expect(await asset.balanceOf(alice.address)).to.equal(usdc(100));

    await escrow.settle();
    const secondSignature = await signOffer(escrow, charlie, 0, cutoff - 1, 1, alice.address);
    await escrow.connect(alice).replace(0, cutoff - 1, 1, alice.address, secondSignature);
    expect((await escrow.places(0)).owner).to.equal(alice.address);
  });

  it("rejects replayed, stale, unauthorized and duplicate-participant offers", async function () {
    const { escrow, alice, bob, charlie, outsider, cutoff } = await fixture();
    await escrow.connect(alice).join();
    const signature = await signOffer(escrow, alice, 0, cutoff - 1, 0, charlie.address);
    await expect(escrow.connect(outsider).replace(0, cutoff - 1, 0, charlie.address, signature)).to.be.revertedWithCustomError(escrow, "InvalidOffer");
    await escrow.connect(charlie).replace(0, cutoff - 1, 0, charlie.address, signature);
    await expect(escrow.connect(bob).replace(0, cutoff - 1, 0, charlie.address, signature)).to.be.revertedWithCustomError(escrow, "InvalidOffer");
    const duplicate = await signOffer(escrow, charlie, 0, cutoff - 1, 1, bob.address);
    await escrow.connect(bob).join();
    await expect(escrow.connect(bob).replace(0, cutoff - 1, 1, bob.address, duplicate)).to.be.revertedWithCustomError(escrow, "AlreadyParticipating");
  });

  it("invalidates signed offers by incrementing the place nonce", async function () {
    const { escrow, alice, charlie, cutoff } = await fixture();
    await escrow.connect(alice).join();
    const signature = await signOffer(escrow, alice, 0, cutoff - 1, 0);
    await escrow.connect(alice).invalidateOffer(0);
    await expect(escrow.connect(charlie).replace(0, cutoff - 1, 0, ethers.ZeroAddress, signature)).to.be.revertedWithCustomError(escrow, "InvalidOffer");
  });

  it("keeps state unchanged when a token transfer cannot complete", async function () {
    const { escrow, alice, bob, charlie, cutoff } = await fixture();
    await escrow.connect(alice).join(); await escrow.connect(bob).join();
    await (await ethers.getContractAt("MockUSDC", await escrow.asset())).connect(charlie).approve(escrow.target, 0);
    const signature = await signOffer(escrow, alice, 0, cutoff - 1, 0);
    await expect(escrow.connect(charlie).replace(0, cutoff - 1, 0, ethers.ZeroAddress, signature)).to.be.reverted;
    expect((await escrow.places(0)).owner).to.equal(alice.address);
    expect((await escrow.places(0)).offerNonce).to.equal(0);
  });
});
