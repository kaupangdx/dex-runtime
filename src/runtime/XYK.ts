import "reflect-metadata";
import {
  RuntimeModule,
  runtimeMethod,
  state,
  runtimeModule,
} from "@proto-kit/module";
import {
  StateMap,
  State,
  assert,
  RuntimeMethodExecutionContext,
} from "@proto-kit/protocol";

import {
  Field,
  Group,
  Poseidon,
  PublicKey,
  Provable,
  SmartContract,
  Struct,
  Signature,
} from "snarkyjs";
import { Balance, Balances, TokenId } from "./Balances";
import { container, inject } from "tsyringe";
import { CompressedSignature } from "@proto-kit/sequencer";

export const errors = {
  poolExists: () => "Pool already exists",
  tokensMatch: () => "Cannot create pool with matching tokens",
  tokenOutAmountTooLow: () => "Token out amount too low",
  tokenInAmountTooHigh: () => "Token in amount too high",
};

export class LPTokenId extends TokenId {
  public static fromTokenIdPair(
    tokenInId: TokenId,
    tokenOutId: TokenId
  ): TokenId {
    return TokenId.from(
      Poseidon.hash(TokenPair.toFields(TokenPair.from(tokenInId, tokenOutId)))
    );
  }
}

export class TokenPair extends Struct({
  tokenInId: TokenId,
  tokenOutId: TokenId,
}) {
  public static from(tokenInId: TokenId, tokenOutId: TokenId) {
    return Provable.if(
      tokenInId.greaterThan(tokenOutId),
      TokenPair,
      new TokenPair({ tokenInId, tokenOutId }),
      new TokenPair({ tokenInId: tokenOutId, tokenOutId: tokenInId })
    );
  }
}

export class PoolKey extends PublicKey {
  public static fromTokenIdPair(
    tokenInId: TokenId,
    tokenOutId: TokenId
  ): PoolKey {
    const tokenPair = TokenPair.from(tokenInId, tokenOutId);

    const {
      x,
      y: { x0 },
    } = Poseidon.hashToGroup(TokenPair.toFields(tokenPair));

    const key = PoolKey.fromGroup(Group.fromFields([x, x0]));

    return key;
  }
}

@runtimeModule()
export class XYK extends RuntimeModule<unknown> {
  public static defaultPoolValue = Field(0);
  @state() public pools = StateMap.from<PoolKey, Field>(PoolKey, Field);

  public constructor(@inject("Balances") public balances: Balances) {
    super();
  }

  public poolExists(tokenInId: TokenId, tokenOutId: TokenId) {
    const key = PoolKey.fromTokenIdPair(tokenInId, tokenOutId);
    const pool = this.pools.get(key);

    return pool.isSome;
  }

  public assertPoolExists(tokenInId: TokenId, tokenOutId: TokenId) {
    assert(this.poolExists(tokenInId, tokenOutId), errors.poolExists());
  }

  @runtimeMethod()
  public createPool(
    tokenInId: TokenId,
    tokenOutId: TokenId,
    tokenInAmount: Balance,
    tokenOutAmount: Balance
  ) {
    assert(tokenInId.equals(tokenOutId).not(), errors.tokensMatch());
    assert(this.poolExists(tokenInId, tokenOutId).not(), errors.poolExists());

    const key = PoolKey.fromTokenIdPair(tokenInId, tokenOutId);
    this.pools.set(key, XYK.defaultPoolValue);

    const creator = this.transaction.sender;
    const pool = PoolKey.fromTokenIdPair(tokenInId, tokenOutId);

    this.balances.transfer(tokenInId, creator, pool, tokenInAmount);
    this.balances.transfer(tokenOutId, creator, pool, tokenOutAmount);

    // mint LP token
    const lpTokenId = LPTokenId.fromTokenIdPair(tokenInId, tokenOutId);
    this.balances.mint(lpTokenId, creator, tokenInAmount);
  }

  public calculateTokenOutAmount(
    tokenInId: TokenId,
    tokenOutId: TokenId,
    tokenInAmount: Balance
  ) {
    const pool = PoolKey.fromTokenIdPair(tokenInId, tokenOutId);

    const tokenInReserve = this.balances.getBalance(tokenInId, pool);
    const tokenOutReserve = this.balances.getBalance(tokenOutId, pool);

    return this.calculateTokenOutAmountFromReserves(
      tokenInReserve,
      tokenOutReserve,
      tokenInAmount
    );
  }

  public calculateTokenOutAmountFromReserves(
    tokenInReserve: Balance,
    tokenOutReserve: Balance,
    tokenInAmount: Balance
  ) {
    const numerator = tokenOutReserve.mul(tokenInAmount);
    const denominator = tokenInReserve.add(tokenInAmount);

    const tokenOutAmount = numerator.div(denominator);

    return tokenOutAmount;
  }

  public calculateTokenInAmount(
    tokenInId: TokenId,
    tokenOutId: TokenId,
    tokenOutAmount: Balance
  ) {
    const pool = PoolKey.fromTokenIdPair(tokenInId, tokenOutId);

    const tokenInReserve = this.balances.getBalance(tokenInId, pool);
    const tokenOutReserve = this.balances.getBalance(tokenOutId, pool);

    return this.calculateTokenInAmountFromReserves(
      tokenInReserve,
      tokenOutReserve,
      tokenOutAmount
    );
  }

  public calculateTokenInAmountFromReserves(
    tokenInReserve: Balance,
    tokenOutReserve: Balance,
    tokenOutAmount: Balance
  ) {
    const paddedTokenOutReserve = tokenOutReserve.add(tokenOutAmount);
    const tokenOutReserveIsSufficient =
      tokenOutReserve.greaterThanOrEqual(tokenOutAmount);

    const safeTokenOutReserve = Provable.if(
      tokenOutReserveIsSufficient,
      Balance,
      tokenOutReserve,
      paddedTokenOutReserve
    );

    const numerator = tokenInReserve.mul(tokenOutAmount);

    const denominator = safeTokenOutReserve.sub(tokenOutAmount);

    const denominatorIsSafe = denominator.greaterThan(Balance.from(0));
    const safeDenominator = Provable.if(
      denominatorIsSafe,
      Balance,
      denominator,
      Balance.from(1)
    );

    assert(denominatorIsSafe);

    const tokenInAmount = numerator.div(safeDenominator);

    return tokenInAmount;
  }

  @runtimeMethod()
  public sell(
    tokenInId: TokenId,
    tokenOutId: TokenId,
    tokenInAmount: Balance,
    minTokenOutAmount: Balance
  ) {
    this.assertPoolExists(tokenInId, tokenOutId);
    const pool = PoolKey.fromTokenIdPair(tokenInId, tokenOutId);

    const tokenOutAmount = this.calculateTokenOutAmount(
      tokenInId,
      tokenOutId,
      tokenInAmount
    );

    const isTokenOutAmountSufficient =
      tokenOutAmount.greaterThanOrEqual(minTokenOutAmount);

    assert(isTokenOutAmountSufficient, errors.tokenOutAmountTooLow());

    this.balances.transfer(
      tokenInId,
      this.transaction.sender,
      pool,
      tokenInAmount
    );

    this.balances.transfer(
      tokenOutId,
      pool,
      this.transaction.sender,
      tokenOutAmount
    );
  }

  @runtimeMethod()
  public buy(
    tokenInId: TokenId,
    tokenOutId: TokenId,
    tokenOutAmount: Balance,
    maxTokenInAmount: Balance
  ) {
    this.assertPoolExists(tokenInId, tokenOutId);
    const pool = PoolKey.fromTokenIdPair(tokenInId, tokenOutId);

    const tokenInAmount = this.calculateTokenInAmount(
      tokenInId,
      tokenOutId,
      tokenOutAmount
    );

    const isMaxTokenInAmountSufficient =
      tokenInAmount.lessThanOrEqual(maxTokenInAmount);

    assert(isMaxTokenInAmountSufficient, errors.tokenInAmountTooHigh());

    this.balances.transfer(
      tokenOutId,
      pool,
      this.transaction.sender,
      tokenOutAmount
    );

    this.balances.transfer(
      tokenInId,
      this.transaction.sender,
      pool,
      tokenInAmount
    );
  }
}
