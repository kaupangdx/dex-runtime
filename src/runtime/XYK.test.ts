import { RuntimeModulesRecord } from "@proto-kit/module";
import { AppChain, ModuleQuery, Query, TestingAppChain } from "@proto-kit/sdk";
import { Field, PrivateKey, Provable, PublicKey, Signature } from "snarkyjs";
import { Balance, Balances, BalancesKey, TokenId } from "./Balances";
import { PoolKey, XYK } from "./XYK";
import log from "loglevel";

log.disableAll();

type RuntimeModules = {
  Balances: typeof Balances;
  XYK: typeof XYK;
};

let nonce = 0;

describe("xyk", () => {
  const aliceKey = PrivateKey.fromBase58(
    "EKFEMDTUV2VJwcGmCwNKde3iE1cbu7MHhzBqTmBtGAd6PdsLTifY"
  );
  const alice = aliceKey.toPublicKey();

  const tokenInId = TokenId.from(0);
  const tokenOutId = TokenId.from(1);

  const pool = PoolKey.fromTokenIdPair(tokenInId, tokenOutId);

  let chain: TestingAppChain<RuntimeModules>;

  let balances: Balances;
  let xyk: XYK;

  const balanceToMint = 10_000n;
  const initialLiquidityA = 1000n;
  const initialLiquidityB = 2000n;

  const balanceToSell = 100n;
  const balanceToBuy = 200n;

  async function getBalance(tokenId: TokenId, address: PublicKey) {
    return await chain.query.runtime.Balances.balances.get(
      new BalancesKey({
        tokenId,
        address,
      })
    );
  }

  beforeAll(async () => {
    chain = TestingAppChain.fromRuntime({
      modules: {
        Balances,
        XYK,
      },
      config: {
        Balances: {},
        XYK: {},
      },
    });

    chain.setSigner(aliceKey);

    await chain.start();

    balances = chain.runtime.resolve("Balances");
    xyk = chain.runtime.resolve("XYK");
  });

  it("should mint balance for alice", async () => {
    const tx1 = chain.transaction(
      alice,
      () => {
        balances.mint(tokenInId, alice, Balance.from(balanceToMint));
      },
      { nonce }
    );

    await tx1.sign();
    await tx1.send();
    nonce++;

    await chain.produceBlock();

    const tx2 = chain.transaction(
      alice,
      () => {
        balances.mint(tokenOutId, alice, Balance.from(balanceToMint));
      },
      { nonce }
    );

    await tx2.sign();
    await tx2.send();
    nonce++;

    await chain.produceBlock();

    const balanceIn = await getBalance(tokenInId, alice);
    const balanceOut = await getBalance(tokenOutId, alice);

    expect(balanceIn?.toBigInt()).toBe(balanceToMint);
    expect(balanceOut?.toBigInt()).toBe(balanceToMint);
  });

  it("should create a pool", async () => {
    const tx = chain.transaction(
      alice,
      () => {
        xyk.createPool(
          tokenInId,
          tokenOutId,
          Balance.from(initialLiquidityA),
          Balance.from(initialLiquidityB)
        );
      },
      { nonce }
    );

    await tx.sign();
    await tx.send();
    nonce++;

    await chain.produceBlock();

    const balanceIn = await getBalance(tokenInId, alice);
    const balanceOut = await getBalance(tokenOutId, alice);

    expect(balanceIn?.toBigInt()).toBe(balanceToMint - initialLiquidityA);
    expect(balanceOut?.toBigInt()).toBe(balanceToMint - initialLiquidityB);
  });

  it("should sell tokenIn", async () => {
    const balanceInBefore = await getBalance(tokenInId, alice);
    const balanceOutBefore = await getBalance(tokenOutId, alice);

    const tx = chain.transaction(
      alice,
      () => {
        xyk.sell(
          tokenInId,
          tokenOutId,
          Balance.from(balanceToSell),
          Balance.from(100n)
        );
      },
      { nonce }
    );

    await tx.sign();
    await tx.send();
    nonce++;

    const block = await chain.produceBlock();

    const balanceInAfter = await getBalance(tokenInId, alice);
    const balanceOutAfter = await getBalance(tokenOutId, alice);

    expect(block?.txs[0].status).toBe(true);

    expect(balanceInAfter?.toBigInt()).toBe(
      balanceInBefore!.toBigInt() - balanceToSell
    );

    expect(balanceOutAfter?.toBigInt()).toBe(
      // 181 = expected calculated amount to receive
      balanceOutBefore!.toBigInt() + 181n
    );
  });

  it("should buy tokenOut", async () => {
    const balanceInBefore = await getBalance(tokenInId, alice);
    const balanceOutBefore = await getBalance(tokenOutId, alice);

    const tx = chain.transaction(
      alice,
      () => {
        xyk.buy(
          tokenInId,
          tokenOutId,
          Balance.from(balanceToBuy),
          Balance.from(10_000n)
        );
      },
      { nonce }
    );

    await tx.sign();
    await tx.send();
    nonce++;

    const block = await chain.produceBlock();

    const balanceInAfter = await getBalance(tokenInId, alice);
    const balanceOutAfter = await getBalance(tokenOutId, alice);

    expect(block?.txs[0].status).toBe(true);

    expect(balanceOutAfter?.toBigInt()).toBe(
      balanceOutBefore!.toBigInt() + balanceToBuy
    );

    expect(balanceInAfter?.toBigInt()).toBe(balanceInBefore!.toBigInt() - 135n);
  });
});
