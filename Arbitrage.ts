import * as _ from "lodash";
import { BigNumber, Contract, Wallet, utils, providers, Signer } from "ethers";
import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { WETH_ADDRESS } from "./addresses";
import { EthMarket } from "./EthMarket";
import { ETHER, bigNumberToDecimal } from "./utils";
import { min } from "lodash";
import { fetchJson, serializeTransaction } from "ethers/lib/utils";
import { BUNDLE_EXECUTOR_ABI } from "./abi"; 
const fetch = require('node-fetch');
const ETH_GAS_STATION = process.env.ETH_GAS_STATION || "X"
const ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL || "X"
const provider = new providers.StaticJsonRpcProvider(ETHEREUM_RPC_URL);
const PRIVATE_KEY = 'X'
const arbitrageSigningWallet = new Wallet(PRIVATE_KEY);
const realcontract = 'X'
const flashbaby = new Contract(realcontract, BUNDLE_EXECUTOR_ABI, provider) 

export interface CrossedMarketDetails {
  profit: BigNumber,
  volume: BigNumber,
  tokenAddress: string,
  buyFromMarket: EthMarket,
  sellToMarket: EthMarket,
}

export type MarketsByToken = { [tokenAddress: string]: Array<EthMarket> }

// TODO: implement binary search (assuming linear/exponential global maximum profitability)
const TEST_VOLUMES = [
  ETHER.mul(5),
	ETHER.mul(7),
  ETHER.mul(10),
  ETHER.mul(20),
  ETHER.mul(30),
  ETHER.mul(40),
  ETHER.mul(50),
  ETHER.mul(60),
  ETHER.mul(70),
  ETHER.mul(80),
  ETHER.mul(90),
  ETHER.mul(100),
  ETHER.mul(150),
  ETHER.mul(200),
  ETHER.mul(250),
  ETHER.mul(300),
  ETHER.mul(350),
  ETHER.mul(400),
  ETHER.mul(450),
  ETHER.mul(500),
  ETHER.mul(750),
  
]

const flashloanFeePercentage = 9 // (0.09%) or 9/10000
export function getBestCrossedMarket(crossedMarkets: Array<EthMarket>[], tokenAddress: string): CrossedMarketDetails | undefined {
  let bestCrossedMarket: CrossedMarketDetails | undefined = undefined;
  for (const crossedMarket of crossedMarkets) {
    const sellToMarket = crossedMarket[0]
    const buyFromMarket = crossedMarket[1]
    for (const size of TEST_VOLUMES) {
      const tokensOutFromBuyingSize = buyFromMarket.getTokensOut(WETH_ADDRESS, tokenAddress, size);
      const proceedsFromSellingTokens = sellToMarket.getTokensOut(tokenAddress, WETH_ADDRESS, tokensOutFromBuyingSize)
      const profit = proceedsFromSellingTokens.sub(size);
      if (bestCrossedMarket !== undefined && profit.lt(bestCrossedMarket.profit)) {
        // If the next size up lost value, meet halfway. TODO: replace with real binary search
        const trySize = size.add(bestCrossedMarket.volume).div(2)
        const tryTokensOutFromBuyingSize = buyFromMarket.getTokensOut(WETH_ADDRESS, tokenAddress, trySize);
        const tryProceedsFromSellingTokens = sellToMarket.getTokensOut(tokenAddress, WETH_ADDRESS, tryTokensOutFromBuyingSize)
        const tryProfit = tryProceedsFromSellingTokens.sub(trySize);
        if (tryProfit.gt(bestCrossedMarket.profit)) {
          bestCrossedMarket = {
            volume: trySize,
            profit: tryProfit,
            tokenAddress,
            sellToMarket,
            buyFromMarket
          }
        }
        break;
      }
        bestCrossedMarket = {
        volume: size,
        profit: profit,
        tokenAddress,
        sellToMarket,
        buyFromMarket
      }
    }
  }
  return bestCrossedMarket;
}

export class Arbitrage { 
        static printCrossedMarket(crossedMarket: CrossedMarketDetails): void {
        const buyTokens = crossedMarket.buyFromMarket.tokens
        const sellTokens = crossedMarket.sellToMarket.tokens
        console.log(
            `Profit: ${bigNumberToDecimal(crossedMarket.profit)} Volume: ${bigNumberToDecimal(crossedMarket.volume)}\n` +
            `${crossedMarket.buyFromMarket.protocol} (${crossedMarket.buyFromMarket.marketAddress})\n` +
            `  ${buyTokens[0]} => ${buyTokens[1]}\n` +
            `${crossedMarket.sellToMarket.protocol} (${crossedMarket.sellToMarket.marketAddress})\n` +
            `  ${sellTokens[0]} => ${sellTokens[1]}\n` +
            `\n`
        )
    }


    async evaluateMarkets(marketsByToken: MarketsByToken): Promise<Array<CrossedMarketDetails>> {
        const bestCrossedMarkets = new Array<CrossedMarketDetails>()

        for (const tokenAddress in marketsByToken) {
            const markets = marketsByToken[tokenAddress]
            const pricedMarkets = _.map(markets, (ethMarket: EthMarket) => {
                return {
                    ethMarket: ethMarket,
                    buyTokenPrice: ethMarket.getTokensIn(tokenAddress, WETH_ADDRESS, ETHER.div(100)),
                    sellTokenPrice: ethMarket.getTokensOut(WETH_ADDRESS, tokenAddress, ETHER.div(100)),
                }
            });

            const crossedMarkets = new Array<Array<EthMarket>>()
            for (const pricedMarket of pricedMarkets) {
                _.forEach(pricedMarkets, pm => {
                    if (pm.sellTokenPrice.gt(pricedMarket.buyTokenPrice)) {
                        crossedMarkets.push([pricedMarket.ethMarket, pm.ethMarket])
                    }
                })
            }

            const bestCrossedMarket = getBestCrossedMarket(crossedMarkets, tokenAddress);
            if (bestCrossedMarket !== undefined && bestCrossedMarket.profit.gt(ETHER.div(50))) {
                bestCrossedMarkets.push(bestCrossedMarket)
            }
        }
        bestCrossedMarkets.sort((a, b) => a.profit.lt(b.profit) ? 1 : a.profit.gt(b.profit) ? -1 : 0)
        return bestCrossedMarkets
    }

    // TODO: take more than 1
    async takeCrossedMarkets(bestCrossedMarkets: CrossedMarketDetails[], blockNumber: number, minerRewardPercentage: number): Promise<void> {
        for (const bestCrossedMarket of bestCrossedMarkets) {

            console.log("Send this much WETH", bestCrossedMarket.volume.toString(), "get this much profit", bestCrossedMarket.profit.toString())
            const buyCalls = await bestCrossedMarket.buyFromMarket.sellTokensToNextMarket(WETH_ADDRESS, bestCrossedMarket.volume, bestCrossedMarket.sellToMarket);
            const inter = bestCrossedMarket.buyFromMarket.getTokensOut(WETH_ADDRESS, bestCrossedMarket.tokenAddress, bestCrossedMarket.volume)
            const sellCallData = await bestCrossedMarket.sellToMarket.sellTokens(bestCrossedMarket.tokenAddress, inter, realcontract.address);
            const targets: Array<string> = [...buyCalls.targets, bestCrossedMarket.sellToMarket.marketAddress]
            const payloads: Array<string> = [...buyCalls.data, sellCallData]
            const flashloanFee = bestCrossedMarket.volume.mul(flashloanFeePercentage).div(10000);
            const profitMinusFee = bestCrossedMarket.profit.sub(flashloanFee)
            const minerReward = 0;
            const ethersAbiCoder = new utils.AbiCoder()
            const typeParams = ['uint256', 'address[]', 'bytes[]']
            const inputParams = [minerReward.toString(), targets, payloads]
            const params = ethersAbiCoder.encode(typeParams, inputParams)
            console.log({ targets, payloads })
            const request = await fetchJson(
                `https://ethgasstation.info/api/ethgasAPI.json?api-key=${process.env.ETH_GAS_STATION}`
            );
            const prices = await request;
            const gasPrice = prices['fastest'] / 10;
            console.log("gas price", gasPrice.toString())
            const gasLimit = 520000
            const gascost = gasPrice * gasLimit
            const profpref = BigNumber.from(profitMinusFee).div(1000000000)
            const profitMinusFeeMinusMinerReward = profpref.sub(gascost)

            console.log("real profit", profitMinusFeeMinusMinerReward.toString())

            if (profitMinusFeeMinusMinerReward.gt(0)) try {
                const realshit = flashbaby.flashloan(
                    WETH_ADDRESS,
                    bestCrossedMarket.volume,
                    params).encodeAbi()
                 const howitsend = {
                     gas: utils.hexlify(gasLimit),
                     gasPrice: utils.hexlify(gasPrice),
                     to: realcontract,
                     data: realshit,
                     from: arbitrageSigningWallet.address,
                     nonce: 0
                }
                
                    const { hash } = await arbitrageSigningWallet.sendTransaction(howitsend)
                    await provider.getTransactionReceipt(hash)
                    

                } catch (e) {
                    console.log("Profit too low.")
                    continue
                }
                        
            return



        } 
    }
}
