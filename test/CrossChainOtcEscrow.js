const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("CrossChain OTC Escrow", function () {
  async function deployFixture() {
    const [owner, keeper, seller, buyer, other] = await ethers.getSigners();

    const AxonEscrow = await ethers.getContractFactory("AxonCrossChainEscrow");
    const axonEscrow = await AxonEscrow.deploy(owner.address, keeper.address);
    await axonEscrow.waitForDeployment();

    const PaymentFactory = await ethers.getContractFactory("BscPaymentVaultFactory");
    const paymentFactory = await PaymentFactory.deploy(owner.address, keeper.address);
    await paymentFactory.waitForDeployment();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdt = await MockERC20.deploy("Mock USDT", "USDT", 18);
    await usdt.waitForDeployment();

    await usdt.mint(buyer.address, ethers.parseUnits("1000", 18));

    return { owner, keeper, seller, buyer, other, axonEscrow, paymentFactory, usdt };
  }

  it("creates a sell order and stores OTC fields", async function () {
    const { seller, axonEscrow } = await deployFixture();
    const axonAmount = ethers.parseEther("10");
    const priceUsd = 25_000;

    await expect(
      axonEscrow
        .connect(seller)
        .createSellOrder(priceUsd, 56, seller.address, "USDT", { value: axonAmount })
    ).to.emit(axonEscrow, "SellOrderCreated");

    const order = await axonEscrow.getOrder(1);
    expect(order.seller).to.equal(seller.address);
    expect(order.buyer).to.equal(ethers.ZeroAddress);
    expect(order.amountAxon).to.equal(axonAmount);
    expect(order.priceUsd).to.equal(priceUsd);
    expect(order.paymentChainId).to.equal(56);
    expect(order.paymentToken).to.equal("USDT");
    expect(order.status).to.equal(0);
  });

  it("completes the order after BSC payment and releases AXON to buyer", async function () {
    const { seller, buyer, keeper, axonEscrow, paymentFactory, usdt } = await deployFixture();
    const axonAmount = ethers.parseEther("8");
    const stableAmount = ethers.parseUnits("20", 18);

    await axonEscrow
      .connect(seller)
      .createSellOrder(250_000, 56, seller.address, "USDT", { value: axonAmount });

    const prepareTx = await paymentFactory
      .connect(keeper)
      .preparePaymentOrder(1, buyer.address, seller.address, seller.address, await usdt.getAddress(), stableAmount);
    const receipt = await prepareTx.wait();
    const preparedEvent = receipt.logs
      .map((log) => {
        try {
          return paymentFactory.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((event) => event && event.name === "PaymentOrderPrepared");
    const vaultAddress = preparedEvent.args.vault;
    const paymentRef = preparedEvent.args.paymentRef;

    await usdt.connect(buyer).approve(vaultAddress, stableAmount);

    const beforeBuyerAxon = await ethers.provider.getBalance(buyer.address);
    await expect(
      (await ethers.getContractAt("BscPaymentVault", vaultAddress)).connect(buyer).pay()
    ).to.emit(paymentFactory, "PaymentReceived");

    expect(await usdt.balanceOf(seller.address)).to.equal(stableAmount);

    await expect(
      axonEscrow.connect(keeper).keeperRelease(1, buyer.address, paymentRef)
    ).to.emit(axonEscrow, "OrderCompleted");

    const order = await axonEscrow.getOrder(1);
    expect(order.status).to.equal(1);
    expect(order.buyer).to.equal(buyer.address);
    expect(order.paymentRef).to.equal(paymentRef);
    expect(await ethers.provider.getBalance(await axonEscrow.getAddress())).to.equal(0);
    expect(await ethers.provider.getBalance(buyer.address)).to.be.gt(beforeBuyerAxon);
  });

  it("supports cancel request, cooldown, and refund to seller", async function () {
    const { seller, axonEscrow } = await deployFixture();
    const axonAmount = ethers.parseEther("3");

    await axonEscrow
      .connect(seller)
      .createSellOrder(123_000, 56, seller.address, "USDT", { value: axonAmount });

    await axonEscrow.connect(seller).requestCancelOrder(1);
    let order = await axonEscrow.getOrder(1);
    expect(order.status).to.equal(2);

    await ethers.provider.send("evm_increaseTime", [15 * 60]);
    await ethers.provider.send("evm_mine");

    const beforeSellerBalance = await ethers.provider.getBalance(seller.address);
    const tx = await axonEscrow.connect(seller).finalizeCancelOrder(1);
    const receipt = await tx.wait();
    const gasCost = receipt.gasUsed * receipt.gasPrice;

    order = await axonEscrow.getOrder(1);
    expect(order.status).to.equal(3);
    expect(await ethers.provider.getBalance(await axonEscrow.getAddress())).to.equal(0);
    expect(await ethers.provider.getBalance(seller.address)).to.equal(beforeSellerBalance + axonAmount - gasCost);
  });

  it("rejects payment from a non-designated buyer", async function () {
    const { seller, buyer, other, keeper, paymentFactory, usdt, axonEscrow } = await deployFixture();
    const stableAmount = ethers.parseUnits("10", 18);

    await axonEscrow
      .connect(seller)
      .createSellOrder(100_000, 56, seller.address, "USDT", { value: ethers.parseEther("1") });

    const prepareTx = await paymentFactory
      .connect(keeper)
      .preparePaymentOrder(1, buyer.address, seller.address, seller.address, await usdt.getAddress(), stableAmount);
    const receipt = await prepareTx.wait();
    const preparedEvent = receipt.logs
      .map((log) => {
        try {
          return paymentFactory.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((event) => event && event.name === "PaymentOrderPrepared");
    const vaultAddress = preparedEvent.args.vault;
    const vault = await ethers.getContractAt("BscPaymentVault", vaultAddress);

    await usdt.mint(other.address, stableAmount);
    await usdt.connect(other).approve(vaultAddress, stableAmount);

    await expect(vault.connect(other).pay()).to.be.revertedWith("ONLY_BUYER");
  });
});
