/* External Imports */
import { getLogger } from '@eth-optimism/core-utils'
import {
  BaseDB,
  DB,
  EthereumBlockProcessor,
  getLevelInstance,
  PostgresDB,
} from '@eth-optimism/core-db'
import { getContractDefinition } from '@eth-optimism/rollup-contracts'
import {
  CalldataTxEnqueuedLogHandler,
  CanonicalChainBatchCreator,
  CanonicalChainBatchSubmitter,
  DataService,
  DefaultDataService,
  DefaultL2NodeService,
  Environment,
  FraudDetector,
  GethSubmissionQueuer,
  L1ChainDataPersister,
  L1ToL2BatchAppendedLogHandler,
  L1ToL2TxEnqueuedLogHandler,
  L2ChainDataPersister,
  L2NodeService,
  QueueOrigin,
  QueuedGethSubmitter,
  SafetyQueueBatchAppendedLogHandler,
  SequencerBatchAppendedLogHandler,
  StateBatchAppendedLogHandler,
  StateCommitmentChainBatchCreator,
  StateCommitmentChainBatchSubmitter,
  updateEnvironmentVariables,
  getL1Provider,
  getL2Provider,
  getSequencerWallet,
  getSubmitToL2GethWallet,
} from '@eth-optimism/rollup-core'

import { Contract, ethers } from 'ethers'

const log = getLogger('service-entrypoint')

/**
 * Runs the configured Rollup services based on configured Environment variables.
 *
 * @returns The services being run.
 */
export const runServices = async (): Promise<any[]> => {
  log.info(`Running services!`)
  const services: any[] = []
  let l1ChainDataPersister: L1ChainDataPersister
  let l2ChainDataPersister: L2ChainDataPersister

  if (Environment.runL1ChainDataPersister()) {
    log.info(`Running L1 Chain Data Persister`)
    l1ChainDataPersister = await createL1ChainDataPersister()
  }
  if (Environment.runL2ChainDataPersister()) {
    log.info(`Running L2 Chain Data Persister`)
    l2ChainDataPersister = await createL2ChainDataPersister()
  }
  if (Environment.runGethSubmissionQueuer()) {
    log.info(`Running Geth Submission Queuer`)
    services.push(await createGethSubmissionQueuer())
  }
  if (Environment.runQueuedGethSubmitter()) {
    log.info(`Running Queued Geth Submitter`)
    services.push(await createQueuedGethSubmitter())
  }
  if (Environment.runCanonicalChainBatchCreator()) {
    log.info(`Running Canonical Chain Batch Creator`)
    services.push(await createCanonicalChainBatchCreator())
  }
  if (Environment.runCanonicalChainBatchSubmitter()) {
    log.info(`Running Canonical Chain Batch Submitter`)
    services.push(await createCanonicalChainBatchSubmitter())
  }
  if (Environment.runStateCommitmentChainBatchCreator()) {
    log.info(`Running State Commitment Chain Batch Creator`)
    services.push(await createStateCommitmentChainBatchCreator())
  }
  if (Environment.runStateCommitmentChainBatchSubmitter()) {
    log.info(`Running State Commitment Chain Batch Submitter`)
    services.push(await createStateCommitmentChainBatchSubmitter())
  }
  if (Environment.runFraudDetector()) {
    log.info(`Running Fraud Detector`)
    services.push(await createFraudDetector())
  }

  services.push(...services)

  if (!services.length) {
    log.error(`No services configured! Exiting =|`)
    process.exit(1)
  }

  await Promise.all(services.map((x) => x.start()))

  const subscriptions: Array<Promise<any>> = []
  if (!!l1ChainDataPersister) {
    services.push(l1ChainDataPersister)
    const l1Processor: EthereumBlockProcessor = createL1BlockSubscriber()
    log.info(`Starting to sync L1 chain`)
    subscriptions.push(
      l1Processor.subscribe(getL1Provider(), l1ChainDataPersister)
    )
  }
  if (!!l2ChainDataPersister) {
    services.push(l2ChainDataPersister)
    const l2Processor: EthereumBlockProcessor = createL2BlockSubscriber()
    log.info(`Starting to sync L2 chain`)
    subscriptions.push(
      l2Processor.subscribe(getL2Provider(), l2ChainDataPersister)
    )
  }

  setInterval(() => {
    updateEnvironmentVariables()
  }, 179_000)

  if (!!subscriptions.length) {
    log.debug(`Awaiting chain subscriptions to sync`)
    await Promise.all(subscriptions)
    log.debug(`Awaiting chain subscriptions are synced!`)
  }

  return services
}

/******************************
 * SERVICE CREATION FUNCTIONS *
 ******************************/

/**
 * Creates and returns an L1ChainDataPersister based on configured environment variables.
 *
 * @returns The L1ChainDataPersister.
 */
const createL1ChainDataPersister = async (): Promise<L1ChainDataPersister> => {
  return L1ChainDataPersister.create(
    getL1BlockProcessorDB(),
    getDataService(),
    getL1Provider(),
    [
      {
        topic: ethers.utils.id('L1ToL2TxEnqueued(bytes)'),
        contractAddress: Environment.getOrThrow(
          Environment.l1ToL2TransactionQueueContractAddress
        ),
        handleLog: L1ToL2TxEnqueuedLogHandler,
      },
      {
        topic: ethers.utils.id('event CalldataTxEnqueued()'),
        contractAddress: Environment.getOrThrow(
          Environment.safetyTransactionQueueContractAddress
        ),
        handleLog: CalldataTxEnqueuedLogHandler,
      },
      {
        topic: ethers.utils.id('L1ToL2BatchAppended(bytes32)'),
        contractAddress: Environment.getOrThrow(
          Environment.canonicalTransactionChainContractAddress
        ),
        handleLog: L1ToL2BatchAppendedLogHandler,
      },
      {
        topic: ethers.utils.id('SafetyQueueBatchAppended(bytes32)'),
        contractAddress: Environment.getOrThrow(
          Environment.canonicalTransactionChainContractAddress
        ),
        handleLog: SafetyQueueBatchAppendedLogHandler,
      },
      {
        topic: ethers.utils.id('SequencerBatchAppended(bytes32)'),
        contractAddress: Environment.getOrThrow(
          Environment.canonicalTransactionChainContractAddress
        ),
        handleLog: SequencerBatchAppendedLogHandler,
      },
      {
        topic: ethers.utils.id('StateBatchAppended(bytes32)'),
        contractAddress: Environment.getOrThrow(
          Environment.stateCommitmentChainContractAddress
        ),
        handleLog: StateBatchAppendedLogHandler,
      },
    ]
  )
}

/**
 * Creates and returns an L2ChainDataPersister based on configured environment variables.
 *
 * @returns The L2ChainDataPersister.
 */
const createL2ChainDataPersister = async (): Promise<L2ChainDataPersister> => {
  return L2ChainDataPersister.create(
    getL2Db(),
    getDataService(),
    getL2Provider()
  )
}

/**
 * Creates and returns an GethSubmissionQueuer based on configured environment variables.
 *
 * @returns The GethSubmissionQueuer.
 */
const createGethSubmissionQueuer = async (): Promise<GethSubmissionQueuer> => {
  const queueOriginsToSendToGeth = [
    QueueOrigin.L1_TO_L2_QUEUE,
    QueueOrigin.SAFETY_QUEUE,
  ]
  if (!Environment.isSequencerStack()) {
    queueOriginsToSendToGeth.push(QueueOrigin.SEQUENCER)
  }
  return new GethSubmissionQueuer(
    getDataService(),
    queueOriginsToSendToGeth,
    Environment.getOrThrow(Environment.gethSubmissionQueuerPeriodMillis)
  )
}

/**
 * Creates and returns an QueuedGethSubmitter based on configured environment variables.
 *
 * @returns The QueuedGethSubmitter.
 */
const createQueuedGethSubmitter = async (): Promise<QueuedGethSubmitter> => {
  return new QueuedGethSubmitter(
    getDataService(),
    getL2NodeService(),
    Environment.getOrThrow(Environment.queuedGethSubmitterPeriodMillis)
  )
}

/**
 * Creates and returns a CanonicalChainBatchCreator based on configured environment variables.
 *
 * @returns The CanonicalChainBatchCreator.
 */
const createCanonicalChainBatchCreator = (): CanonicalChainBatchCreator => {
  return new CanonicalChainBatchCreator(
    getDataService(),
    Environment.canonicalChainMinBatchSize(10),
    Environment.canonicalChainMaxBatchSize(100),
    Environment.getOrThrow(Environment.canonicalChainBatchCreatorPeriodMillis)
  )
}

/**
 * Creates and returns a CanonicalChainBatchSubmitter based on configured environment variables.
 *
 * @returns The CanonicalChainBatchSubmitter.
 */
const createCanonicalChainBatchSubmitter = (): CanonicalChainBatchSubmitter => {
  const contract: Contract = new Contract(
    Environment.getOrThrow(
      Environment.canonicalTransactionChainContractAddress
    ),
    getContractDefinition('CanonicalTransactionChain').abi,
    getSequencerWallet()
  )

  return new CanonicalChainBatchSubmitter(
    getDataService(),
    contract,
    Environment.getOrThrow(Environment.finalityDelayInBlocks),
    Environment.getOrThrow(Environment.canonicalChainBatchSubmitterPeriodMillis)
  )
}

/**
 * Creates and returns a StateCommitmentChainBatchCreator based on configured environment variables.
 *
 * @returns The StateCommitmentChainBatchCreator.
 */
const createStateCommitmentChainBatchCreator = (): StateCommitmentChainBatchCreator => {
  return new StateCommitmentChainBatchCreator(
    getDataService(),
    Environment.stateCommitmentChainMinBatchSize(10),
    Environment.stateCommitmentChainMaxBatchSize(100),
    Environment.getOrThrow(
      Environment.stateCommitmentChainBatchCreatorPeriodMillis
    )
  )
}

/**
 * Creates and returns a StateCommitmentChainBatchSubmitter based on configured environment variables.
 *
 * @returns The StateCommitmentChainBatchSubmitter.
 */
const createStateCommitmentChainBatchSubmitter = (): StateCommitmentChainBatchSubmitter => {
  return new StateCommitmentChainBatchSubmitter(
    getDataService(),
    new Contract(
      Environment.getOrThrow(Environment.stateCommitmentChainContractAddress),
      getContractDefinition('StateCommitmentChain').abi,
      getSequencerWallet()
    ),
    Environment.getOrThrow(Environment.finalityDelayInBlocks),
    Environment.getOrThrow(
      Environment.stateCommitmentChainBatchSubmitterPeriodMillis
    )
  )
}

/**
 * Creates and returns a FraudDetector based on configured environment variables.
 *
 * @returns The FraudDetector.
 */
const createFraudDetector = (): FraudDetector => {
  return new FraudDetector(
    getDataService(),
    undefined, // TODO: ADD FRAUD PROVER HERE WHEN THERE IS ONE
    Environment.getOrThrow(Environment.fraudDetectorPeriodMillis),
    Environment.getOrThrow(
      Environment.reAlertOnUnresolvedFraudEveryNFraudDetectorRuns
    )
  )
}

const createL1BlockSubscriber = (): EthereumBlockProcessor => {
  return new EthereumBlockProcessor(
    getL1BlockProcessorDB(),
    Environment.getOrThrow(Environment.l1EarliestBlock),
    Environment.getOrThrow(Environment.finalityDelayInBlocks)
  )
}

const createL2BlockSubscriber = (): EthereumBlockProcessor => {
  return new EthereumBlockProcessor(getL2Db(), 0, 1)
}

/*********************
 * HELPER SINGLETONS *
 *********************/

let l1BlockProcessorDb: DB
const getL1BlockProcessorDB = (): DB => {
  if (!l1BlockProcessorDb) {
    l1BlockProcessorDb = new BaseDB(
      getLevelInstance(
        Environment.getOrThrow(Environment.l1ChainDataPersisterLevelDbPath)
      ),
      256
    )
  }
  return l1BlockProcessorDb
}

let l2Db: DB
const getL2Db = (): DB => {
  if (!l2Db) {
    l2Db = new BaseDB(
      getLevelInstance(
        Environment.getOrThrow(Environment.l2ChainDataPersisterLevelDbPath)
      ),
      256
    )
  }
  return l2Db
}

let dataService: DataService
const getDataService = (): DataService => {
  if (!dataService) {
    dataService = new DefaultDataService(
      new PostgresDB(
        Environment.getOrThrow(Environment.postgresHost),
        Environment.getOrThrow(Environment.postgresPort),
        Environment.getOrThrow(Environment.postgresUser),
        Environment.getOrThrow(Environment.postgresPassword),
        Environment.postgresDatabase('rollup'),
        Environment.postgresPoolSize(20),
        Environment.postgresUseSsl(false)
      )
    )
  }
  return dataService
}

let l2NodeService: L2NodeService
const getL2NodeService = (): L2NodeService => {
  if (!l2NodeService) {
    l2NodeService = new DefaultL2NodeService(getSubmitToL2GethWallet())
  }
  return l2NodeService
}
