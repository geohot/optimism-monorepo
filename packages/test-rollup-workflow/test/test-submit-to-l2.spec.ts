import './setup'

/* External Imports */
import { Contract, ContractFactory, Wallet } from 'ethers'
import { JsonRpcProvider, Provider, TransactionReceipt } from 'ethers/providers'

import * as SimpleStorageContract from '../build/SimpleStorage.json'

describe.skip('Test Sending Transactions Directly To L2', () => {
  let wallet: Wallet
  let provider: Provider
  let simpleStorage: Contract

  before(async () => {
    provider = new JsonRpcProvider('TODO: URL to node here')
    wallet = Wallet.createRandom().connect(provider)

    const factory = new ContractFactory(
      SimpleStorageContract.abi,
      SimpleStorageContract.bytecode,
      wallet
    )

    const deployTx = factory.getDeployTransaction()
    deployTx.gasPrice = 0
    const res = await wallet.sendTransaction(deployTx)
    const receipt: TransactionReceipt = await provider.waitForTransaction(
      res.hash
    )
    receipt.status.should.equal(1, `Deploy transaction failed`)
    simpleStorage = new Contract(
      receipt.contractAddress,
      SimpleStorageContract.abi,
      wallet
    )
  })

  it('Sets storage 10 times', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await simpleStorage.setStorage('test', `test${i}`)
      const receipt: TransactionReceipt = await provider.waitForTransaction(
        res.hash
      )
      receipt.status.should.equal(
        1,
        `Transaction ${i} failed! ${JSON.stringify(receipt)}`
      )

      const setStorage = await simpleStorage.getStorage('test')
      setStorage.should.equal(`test${i}`, `Storage not set to test${i}`)
    }
  })
})
