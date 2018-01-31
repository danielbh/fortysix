const chalk = require('chalk')
const {
  History,
  Room,
  Selections,
  Parameters,
  Mutations
} = require('../db/models')
const { generateTasks } = require('./tasks')

class RoomManager {
  constructor(roomHash, socket) {
    this.room = roomHash
    this.nodes = {
      [socket.id]: {
        running: false,
        error: false
      }
    }
    this.tasks = []
    this.jobRunning = false
    this.start = null
    this.lastResult = null
    this.bucket = {}
    this.maxGen = null
    this.populationSize = null
    this.chromosomeLength = null
    this.fitnessGoal = null
    this.elitism = null
    this.fitness = null
    this.mutuations = null
    this.selection = null
    this.genePool = ['1', '0']
    this.admins = {}
  }
  join(socket) {
    socket.join(this.room)
    this.nodes[socket.id] = { running: false, error: false }
    // this.admins.forEach(admin => admin.emit('UPDATE_' + this.room, this))
    // socket.broadcast.to(this.room).emit('UPDATE_' + this.room, this)
  }
  leave(socket) {
    delete this.nodes[socket.id]
    socket.leave(this.room)
    socket.broadcast.to(this.room).emit('UPDATE_' + this.room, this)
  }
  abort(socket) {
    this.start = null
    this.tasks = []
    this.jobRunning = false
    this.multiThreaded = false
    this.bucket = {}
    this.nodes = {}
    socket.broadcast.to(this.room).emit('ABORT_' + this.room)
  }
  jobError(socket, error) {
    this.nodes[socket.id].running = false
    this.nodes[socket.id].error = true
    socket.broadcast.to(this.room).emit('UPDATE_' + this.room, this)
    throw new Error(`JOB_ERROR: ${this.room} for socket: ${socket.id}, `, error)
  }
  isJobRunning() {
    return this.jobRunning
  }
  startJob() {
    this.jobRunning = true
    let mutations = this.mutations
    let selection = this.selection
    // generates 4X tasks for each node in the system
    this.tasks = generateTasks(
      this.populationSize,
      this.room,
      Object.keys(this.nodes).length * 4,
      this.fitness,
      mutations,
      selection,
      this.chromosomeLength,
      this.genePool
    )
  }
  mapPersistedToMemory(room) {
    // takes the room in the database, and maps its properties to the in room memory that the sockets use
    return Room.findOne({
      where: { roomHash: room || null },
      include: [{
        model: Parameters,
        through: {
          attributes: []
        }
      },
      {
        model: Selections,
        attributes: ['name', 'function']
      },
      {
        model: Mutations,
        attributes: ['function'],
        through: {
          attributes: ['chanceOfMutation']
        }
      }]
    })
      .then((roomFromDb) => {
      // Decycle and reshape mutations array because Sequelize isn't perfect
        const { mutations, ...rest } = JSON.parse(JSON.stringify(roomFromDb))
        const newMutations = mutations.map((mutation) => {
          mutation.chanceOfMutation = mutation.room_mutations.chanceOfMutation
          delete mutation.room_mutations
          return mutation
        })
        return { ...rest, mutations: newMutations }
      })
      .then(({ mutations, selection, parameters, fitnessFunc }) => {
        this.mutations = mutations
        this.selection = selection
        // Hack to make front end still work because it expects {function}
        this.fitness = { function: fitnessFunc }
        this.start = Date.now()
        this.totalFitness = 0
        this.chromosomesReturned = 0
        this.maxGen = parameters[0].generations
        this.populationSize = parameters[0].populationSize
        this.chromosomeLength = parameters[0].chromosomeLength
        this.elitism = parameters[0].elitism
        this.fitnessGoal = parameters[0].fitnessGoal
        Object.keys(this.nodes).forEach((socketId) => {
          this.nodes[socketId].running = true
          this.nodes[socketId].error = false
        })
        return this
      })
      .catch(err => console.err(err))
  }
  updateRoomStats(finishedTask) {
    this.totalFitness += finishedTask.fitnesses[0] + finishedTask.fitnesses[1]
    this.chromosomesReturned += finishedTask.population.length
  }
  updateBucket(finishedTask) {
    // if the room's bucket contains a task with the current incoming generation...
    if (this.bucket[finishedTask.gen]) {
      this.bucket[finishedTask.gen].population =
        this.bucket[finishedTask.gen].population.concat(finishedTask.population)
      this.bucket[finishedTask.gen].fitnesses =
        this.bucket[finishedTask.gen].fitnesses.concat(finishedTask.fitnesses)
    }
    // if not, make a new key in the bucket for the new incoming generation
    else {
      this.bucket[finishedTask.gen] = finishedTask
    }
  }
  shouldTerminate() {
    // right now this function doesn't do anything with the finishedTask,
    // but it will when we use elitism or a maxFitness
    return this.bucket[this.maxGen] && this.bucket[this.maxGen].population.length >= this.populationSize && this.isJobRunning()
  }
  finalSelection() {
    // takes the max generation and selects the most fit chromosome
    const finalGeneration = this.bucket[this.maxGen]
    const results = {}
    results.room = this.room

    let mostFit = finalGeneration.fitnesses[0]
    let mostFitChromosome = finalGeneration.population[0]

    for (let i = 0; i < finalGeneration.fitnesses.length; i++) {
      if (finalGeneration.fitnesses[i] > mostFit) {
        mostFit = finalGeneration.fitnesses[i]
        mostFitChromosome = finalGeneration.population[i]
      }
    }
    results.fitness = mostFit
    results.winningChromosome = mostFitChromosome
    return results
  }
  stopJob() {
    this.jobRunning = false
    // if the job is finished, each node stops running
    Object.keys(this.nodes).forEach((nodeId) => this.nodes[nodeId].running = false)

    // History.create({
    //   nodes: Object.keys(room.nodes).length,
    //   result: room.lastResult.tour + ' ' + room.lastResult.dist,
    //   startTime: room.start,
    //   multiThreaded: room.multiThreaded,
    //   endTime,
    //   room
    // })
    //   .then(() => {
    //     History.findAll({
    //       where: {
    //         room
    //       }
    //     }).then((history) => {
    //       io.sockets.emit('UPDATE_HISTORY_' + room, history)
    //     })
    //     rooms[room].start = null
    //     rooms[room].maxGen = null
    //     // rooms[room].populationSize = null
    //     rooms[room].lastResult = {
    //       maxGeneration: 0,
    //       maxFitness: 0
    //     }
    //   })
    this.start = null
    this.maxGen = null
    this.lastResult = {
      maxGeneration: 0,
      maxFitness: 0
    }
  }
  emptyTaskQueue() {
    this.tasks = []
  }
  totalTasks() {
    return this.tasks.length
  }
  // NEEDS TO GET RID OF ANY IO SOCKET CALLING
  distributeWork(socket) {
    console.log('SOCKET ABOUT TO GET WORK', socket.id, this.room, this.tasks)
    this.nodes[socket.id].running = true
    socket.to(socket.id).emit('CALL_' + this.room, this.tasks.shift())
  }
  createMoreTasks(finishedTask) {
    if (this.bucket[finishedTask.gen].population.length >= this.populationSize) {
      this.tasks.push(this.bucket[finishedTask.gen])
      this.bucket[finishedTask.gen] = null
    } else {
      const newTask = generateTasks(
        this.populationSize,
        finishedTask.room,
        1,
        this.fitness,
        this.mutations,
        this.selection,
        this.chromosomeLength,
        this.genePool
      )
      this.tasks =
        this.tasks.concat(newTask)
    }
  }
  addAdmin(socket) {
    this.admins[socket.id] = socket
    // this.admins.push(socket)
  }
  async jobInit(socket, io) {
    const callName = 'CALL_' + this.room
    // takes the room stored in the database, and maps it to the in memory room
    const updatedRoom = await this.mapPersistedToMemory(this.room)
    socket.broadcast.to(this.room).emit('UPDATE_' + updatedRoom.room, this)
    // checks to see if the job is running already and if not, starts the job
    if (!this.isJobRunning()) {
      this.startJob()
      Object.keys(this.nodes).forEach((id, i) => {
        console.log('NODE ID', id)
        socket.to(id).emit(callName, this.tasks.shift())
      })
    } else {
      console.log(chalk.red(`${startName} already running!`))
    }
  }
  terminateOrDistribute(finishedTask, socket, io) {
    // decides whether to hand off the final generation to the final selection function OR distributes the next task on queue to the worker node

    // Avoid pushing history multiple times by checking jobRunning
    // if termination condition is met and the alg is still running..
    console.log('CLIENT SENT BACK WORK, WERE FIGURING IT OUT', finishedTask)
    const allDone = this.shouldTerminate()
    if (allDone) {
      // terminate
      const results = this.finalSelection()
      this.algorithmDone(results.room, results.winningChromosome, results.fitness, io)
      this.emptyTaskQueue()
    } else {
      // distribute
      if (this.totalTasks() > 0) this.distributeWork(socket)
      this.createMoreTasks(finishedTask)
    }
    socket.broadcast.to(this.room).emit('UPDATE_' + this.room, this)
  }
  algorithmDone(room, winningChromosome, fitness, io) {
    const endTime = Date.now()
    console.log(
      chalk.green(`DURATION OF ${room}: `, endTime - room.start)
    )

    console.log(
      chalk.magenta(`BEST CHROMOSOME: ${winningChromosome}`)
    )

    console.log(
      chalk.magenta(`BEST FITNESS: ${fitness}`)
    )

    io.sockets.emit('UPDATE_' + room, getRoom(room))
    this.stopJob()
  }
}

module.exports = { RoomManager }
