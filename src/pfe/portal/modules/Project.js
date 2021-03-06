/*******************************************************************************
 * Copyright (c) 2019 IBM Corporation and others.
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v2.0
 * which accompanies this distribution, and is available at
 * http://www.eclipse.org/legal/epl-v20.html
 *
 * Contributors:
 *     IBM Corporation - initial API and implementation
 *******************************************************************************/

const fs = require('fs-extra');
const { extname, isAbsolute, join } = require('path');
const uuidv1 = require('uuid/v1');
const Client = require('kubernetes-client').Client
const config = require('kubernetes-client').config;
const rimraf = require('rimraf')

const cwUtils = require('./utils/sharedFunctions');
const metricsStatusChecker = require('./utils/metricsStatusChecker');
const ProjectError = require('./utils/errors/ProjectError');
const ProjectMetricsError = require('./utils/errors/ProjectMetricsError');
const Logger = require('./utils/Logger');
const LogStream = require('./LogStream');
const metricsService = require('./metricsService');
const Links = require('./project/Links');

const log = new Logger(__filename);

// Declaring STATES here makes it accessible in this file.
// We add it to the exported Project class so it can be
// reached by users of the Project class.
const STATES = {
  closed: 'closed',
  open: 'open',
  validating: 'validating',
  closing: 'closing',
  deleting: 'deleting'
};

const METRICS_DASH_HOST = {
  project: 'project',
  performanceContainer: 'performanceContainer',
};

const pathsToUserHostedMetricsDashboards = {
  nodejs: 'appmetrics-dash',
  javascript: 'appmetrics-dash',
  java: 'javametrics-dash',
  swift: 'swiftmetrics-dash',
};

const METRIC_TYPES = ['cpu', 'gc', 'memory', 'http']

const CW_SETTINGS_PROPERTIES = [
  "contextRoot", "internalPort", "internalDebugPort", "statusPingTimeout",
  "healthCheck", "isHttps", "ignoredPaths", "mavenProfiles", "mavenProperties"
];

/**
 * The Project class
 * Contains information about an individual project
 * One per project
 */
module.exports = class Project {

  constructor(args) {
    this.projectID = args.projectID || uuidv1();
    this.name = args.name;
    this.codewindVersion = args.codewindVersion || process.env.CODEWIND_VERSION;
    this.language = args.language;
    this.creationTime = args.creationTime;

    if (args.contextRoot) this.contextRoot = args.contextRoot;
    if (args.extension) this.extension = args.extension;

    // locOnDisk is used by the UI and needs to match what it sees.
    if (args.locOnDisk) this.locOnDisk = args.locOnDisk;

    // Set up the pathToMonitor, this must always be unix style
    if (args.pathToMonitor) { 
      this.pathToMonitor = args.pathToMonitor;
    } else {
      this.pathToMonitor = this.locOnDisk;
      const isWindowsPath = cwUtils.isWindowsAbsolutePath(this.pathToMonitor);
      if (isWindowsPath) {
        this.pathToMonitor = cwUtils.convertFromWindowsDriveLetter(this.pathToMonitor);
      } 
    }
    
    // Project status information
    this.host = args.host || '';
    this.ports = args.ports || {};

    this.workspace = args.workspace;
    this.directory = args.directory || this.name;
    this.infLockFlag = false;

    this.loadTestPath = join(this.workspace, this.name, 'load-test');

    if (this.language === 'java') {
      this.startMode = args.startMode || 'run';
    }

    // Initialise the project type
    this.projectType = args.projectType;

    // Initialise isOpenLiberty as false
    // We scan the project later to determine if its open liberty (setOpenLiberty)
    this.isOpenLiberty = false;
    this.canMetricsBeInjected = metricsService.metricsCollectorInjectionFunctions.hasOwnProperty(this.projectType);

    log.info(`Project ${this.name} initializing (project type: ${this.projectType}, projectID: ${this.projectID})`);

    // This is used to delete the log file when the project is deleted.
    this.buildLogPath = args.buildLogPath || null;
    this.logStreams = {};

    // Default to open for old projects
    this.state = args.state || STATES.open;
    // Default auto building to true
    this.autoBuild = true;
    if (args.hasOwnProperty('autoBuild')) {
      this.autoBuild = args.autoBuild;
    }

    // Default the injection of monitoring to be off
    this.injectMetrics = false;
    if (args.hasOwnProperty('injectMetrics')) {
      this.injectMetrics = args.injectMetrics;
    }
    this.capabilitiesReady = false;

    this.links = new Links(this.projectPath(), args.links);
  }


  // Ask Kube for project connection details by querying the project service
  async getProjectKubeService() {
    if (global.codewind.RUNNING_IN_K8S) {
      try {
        const namespace = process.env.KUBE_NAMESPACE
        const projectID = this.projectID
        const client = new Client({ config: config.getInCluster(), version: '1.9' });
        const services = await client.api.v1.namespaces(namespace).services.get({ qs: { labelSelector: 'projectID='+projectID } })

        if (services && services.body && services.body.items && services.body.items[0]) {
          const ipAddress = services.body.items[0].spec.clusterIP
          const port = services.body.items[0].spec.ports[0].targetPort
          const serviceName = services.body.items[0].metadata.name

          // update service host
          this.kubeServiceHost = ipAddress
          this.kubeServicePort = port
          this.kubeServiceName = serviceName
          return { hostname: ipAddress, port, serviceName }
        }
      } catch (error) {
        log.error(error)
      }
    }
    return {}
  }

  getPerfDashPath() {
    const isPerfDashAvailable = this.injectMetrics || this.isOpenLiberty || this.metricsAvailable;
    return isPerfDashAvailable
      ? `/performance/charts?project=${this.projectID}`
      : null;
  }

  getMetricsDashHost() {
    const isMetricsDashAvailable = this.injectMetrics || this.isOpenLiberty || this.metricsAvailable;
    if (!isMetricsDashAvailable) {
      return null;
    }
    let shouldShowMetricsDashHostedOnProject = false;
    if (this.projectType === "appsodyExtension") {
      if (!(this.language === "java")) {
        shouldShowMetricsDashHostedOnProject = true;
      }
    } else {
      shouldShowMetricsDashHostedOnProject = !this.injectMetrics && this.metricsAvailable;
    }

    return shouldShowMetricsDashHostedOnProject ? METRICS_DASH_HOST.project : METRICS_DASH_HOST.performanceContainer;
  }
  
  getMetricsDashPath() {
    const metricsDashHost = this.getMetricsDashHost();
    if (!metricsDashHost) {
      return null;
    }
    
    if (metricsDashHost === METRICS_DASH_HOST.project) {
      return `/${pathsToUserHostedMetricsDashboards[this.language]}/?theme=dark`;
    }

    if (metricsDashHost === METRICS_DASH_HOST.performanceContainer) {
      return `/performance/monitor/dashboard/${this.language}?theme=dark&projectID=${this.projectID}`
    }
    
    throw new Error(`unknown metricsDashHost: ${metricsDashHost}`);
  }

  async isMetricsAvailable() {
    // hardcoding a return of true for appsody projects until we have a better
    // way of detecting appsody has the dashboard dependency
    if (this.projectType === "appsodyExtension" && ['nodejs', 'javascript', 'java', 'swift'].includes(this.language)) {
      return true;
    } 
    const isMetricsAvailable = await metricsStatusChecker.isMetricsAvailable(this.projectPath(), this.language);
    return isMetricsAvailable;
  }
  
  async setOpenLiberty() {
    const isProjectOpenLiberty = await metricsService.determineIfOpenLiberty(this.projectType, this.language, this.projectPath());
    // If Open Liberty override canMetricsBeInjected
    if (isProjectOpenLiberty) this.canMetricsBeInjected = true;
    this.isOpenLiberty = isProjectOpenLiberty;
  }

  /**
   * Function to return the port that the project is running on.
   * @return the port.
   */

  getPort() {
    let port = this.ports.exposedPort;
    if (!global.codewind.RUNNING_IN_K8S) {
      port = this.ports.internalPort;
    }
    return port;
  }

  /**
   * Function to return the metrics cotext root for the project.
   * @return the metrics context root.
   */

  getMetricsContextRoot() {
    let metricsContextRoot = "";
    switch (this.language) {
    case 'java':
      metricsContextRoot = 'javametrics';
      break;
    case 'nodejs':
    case 'javascript':
      metricsContextRoot = 'appmetrics';
      break;
    case 'swift':
      metricsContextRoot = 'swiftmetrics';
      break;
    default:
    }
    return metricsContextRoot;
  }

  /**
   * Function to return the path to the project directory
   * @return the path to the project directory.
   */
  projectPath() {
    return join(this.workspace, this.directory);
  }

  /**
   * Function to read the project .cw-settings file
   * @return the contents of the file as an object containing key-value pairs
   */
  async readSettingsFile() {
    const settingsFile = join(this.projectPath(), '.cw-settings');
    let currentSettings = {};
    if (await fs.pathExists(settingsFile)) {
      currentSettings = await fs.readJson(settingsFile);
    }
    return currentSettings;
  }

  /**
   * Function to read the project .cw-refpaths.json file
   * @return the contents of the file is an object containing a refPaths array
   */
  async readRefPathsFile() {
    const refPathsFile = join(this.projectPath(), '.cw-refpaths.json');
    let refPaths;
    if (await fs.pathExists(refPathsFile)) {
      refPaths = await fs.readJson(refPathsFile, { throws: false });
    }
    return refPaths || {};
  }

  /**
   * Function to generate the project information file
   * @return this, the project object
   */
  async writeInformationFile() {
    let infFileDirectory = join(global.codewind.CODEWIND_WORKSPACE, '.projects');
    let infFile = join(infFileDirectory, `${this.projectID}.inf`);
    await fs.ensureDir(infFileDirectory);

    // Write to the file under this projects lock.
    // .inf files are only read on portal startup, the rest of the time
    // we use the in memory object we are serializing here.
    // A simple lock works as NodeJs is single threaded.

    // Ensure we don't wait forever.
    let count = 0;
    let haveLock = false;
    while(count < 1000) {
      count++;
      if( this.infLockFlag == false ) {
        this.infLockFlag = true;
        haveLock = true;
        break;
      } else {
      // Wait as short a time as possible.
        await cwUtils.timeout(1);
      }
    }
    if (!haveLock) {
      throw new ProjectError('LOCK_FAILURE', this.name);
    }
    try {
      // Fields that shouldn't be persisted to .inf files are stripped out by filterNonPersistentFields below.
      // Fields that can't be converted to JSON (because e.g. they contain circular refs) are filtered out by toJSON().
      // Important: toJSON() works if the object is returned over REST or dumped in a debug message.
      await fs.writeJson(infFile, this, { spaces: '  ', replacer: Project.filterNonPersistentFields });
    } catch(err) {
      log.error(err);
    } finally {
      this.infLockFlag = false;
    }
    // May return before we've finished writing.
    return this;
  }

  toJSON() {
    // Strip out fields we don't want to attempt to turn into JSON.
    // (This is our guard against trying to write circular references.)
    const { logStreams, loadInProgress, loadConfig, operation, ...filteredProject } = this;
    return filteredProject;
  }

  static filterNonPersistentFields(key, value) {
    // Strip out fields we don't want to save in the .inf file.
    const nonPersistentFields = [
      'capabilitiesReady',
      'detailedAppStatus',
      'infLockFlag'
    ];
    if (nonPersistentFields.includes(key)) {
      return undefined;
    }
    return value;
  }

  /**
   * Function to return the path of the build log file for this project
   * @return the build log file path for this project
   */
  getBuildLogPath() {
    if (!this.buildLogPath) {
      return null;
    }
    // buildLogPath is the single user path the file-watcher sees, we need to
    // fix it for multi-user environments where portal sees all users.
    return this.buildLogPath.replace('/codewind-workspace/', global.codewind.CODEWIND_WORKSPACE);
  }

  /**
   * Function to return a list of metric types that are available for this project. We
   * obtain the metric types by finding and examining a metrics.json file. This is the
   * summary file that the jmeter support creates for each load test run. If there were
   * no load test runs for this project yet, or there were problems finding or reading a
   *  metrics.json file we throw a ProjectError exception back to the API in server.js.
   * @return the list of metric types.
   */
  static getMetricTypes() {
    return METRIC_TYPES;
  }

  /**
   * Function to return values of a metric for a project. We obtain the metric by finding
   * and examining metrics.json files for the project. These are the summary files that
   * the jmeter support creates for each load test run. If there were no load test runs for
   * this project yet, or there were problems finding or reading a metrics.json file we
   * throw a ProjectError exception back to the API in server.js.
   * @param {String} type metric type
   * @return {[JSON]} time/value pairs for the requested metric.
   */
  async getMetrics(type) {
    log.trace(`[getMetrics] type=${type}`);

    let metrics = [];
    const loadTestDirectories = await getLoadTestDirs(this.loadTestPath);
    if (!Project.getMetricTypes().includes(type)) {
      throw new ProjectError("INVALID_METRIC_TYPE", type, `[${Project.getMetricTypes()}]`);
    }
    //We want the type to be exposed as http, but metrics stores the file as httpUrl
    const metricsFileType = (type === 'http') ? 'httpUrls' : type;

    // Look for project load-test directories and check for metrics.json files
    // Read in the requested metric from all the available test runs
    loadTestDirectories.sort();
    for (let i = 0; i < loadTestDirectories.length; i++) {
      const metricsFile = await fs.readJson(join(this.loadTestPath, loadTestDirectories[i], 'metrics.json'));
      // Now construct the timestamp and the metric required from the JSON file
      // If a file doesn't include the metrics of that type, skip the file
      if (metricsFile[metricsFileType] != undefined) {
        const metric = {
          container: loadTestDirectories[i],
          time: metricsFile.time.data.start || metricsFile.time.data.startTime,
          endTime: metricsFile.time.data.end || metricsFile.time.data.endTime,
          value: metricsFile[metricsFileType] };
        if (metricsFile.desc) {
          metric.desc = metricsFile.desc;
        }
        metrics.push(metric);
      }
    }
    return metrics;
  }

  /**
   * @param {String|Int} timeOfTestRun in 'yyyymmddHHMMss' format
   */
  async getMetricsByTime(timeOfTestRun) {
    const pathToMetricsJson = await this.getPathToMetricsFile(timeOfTestRun);
    const metrics = await fs.readJson(pathToMetricsJson);
    return metrics;
  }

  /**
   * @param {String|Int} timeOfTestRun in 'yyyymmddHHMMss' format
   */
  async getProfilingByTime(timeOfTestRun) {
    const pathToProfilingFile = await this.getPathToProfilingFile(timeOfTestRun);
    let profilingStream;
    try {
      profilingStream = fs.createReadStream(pathToProfilingFile);
    } catch (error) {
      throw new ProjectMetricsError("STREAM_FAILED", pathToProfilingFile, error.message);
    }
    log.info(`Returning profiling file stream ${pathToProfilingFile} for ${this.name}`);
    return profilingStream;
  } 

  /**
   * @param {String|Int} timeOfTestRun in 'yyyymmddHHMMss' format
   */
  async deleteMetrics(timeOfTestRun) {
    let pathToLoadTestDir = null;
    try {
      pathToLoadTestDir = await this.getPathToLoadTestDir(timeOfTestRun);
    } catch (err) {
      pathToLoadTestDir = await this.getClosestPathToLoadTestDir(timeOfTestRun);
    }
    await fs.remove(pathToLoadTestDir);
  }

  /**
   * Get the folder name closest to the supplied timeOfTestRun. Required since there may be a delay
   * between when the collection folder was created and the start timestamp of the metrics.
   * Throws not found if the timeOfTestRun is lower than the earliest time
   * @param {String|Int} timeOfTestRun in 'yyyymmddHHMMss' format
   */
  async getClosestPathToLoadTestDir(timeOfTestRun) {
    log.trace(`[getPathToClosestLoadTestDir] timeOfTestRun=${timeOfTestRun}`);
    const loadTestDirs = await getLoadTestDirs(this.loadTestPath);
    const intTimeOfTestRun = parseInt(timeOfTestRun);
    let closestDirectory;
    loadTestDirs.forEach(testDirectory => {
      const intDirectory = parseInt(testDirectory);
      if (!isNaN(intDirectory) && intDirectory <= intTimeOfTestRun) {
        closestDirectory = intDirectory;
      }
    });
    if (closestDirectory) {
      return join(this.loadTestPath, `${closestDirectory}`);
    }
    throw new ProjectMetricsError('NOT_FOUND', this.projectID, `found no load-test metrics from time ${timeOfTestRun}`)
  }

  /**
   * @param {String|Int} timeOfTestRun in 'yyyymmddHHMMss' format
   */
  async getPathToLoadTestDir(time) {
    const timeOfTestRun = String(time);
    log.trace(`[getPathToLoadTestDir] timeOfTestRun=${timeOfTestRun}`);
    const loadTestDirs = await getLoadTestDirs(this.loadTestPath);
    const loadTestDir = loadTestDirs.find(dirname => dirname === timeOfTestRun);    
    if (!loadTestDir) {
      throw new ProjectMetricsError('NOT_FOUND', this.projectID, `found no exact match load-test metrics from time ${timeOfTestRun}`)
    }
    const pathToLoadTestDir = join(this.loadTestPath, loadTestDir);
    return pathToLoadTestDir;
  }

  /**
   * @param {String|Int} timeOfTestRun in 'yyyymmddHHMMss' format
   */
  async getPathToMetricsFile(timeOfTestRun) {
    let pathToLoadTestDir;
    try {
      pathToLoadTestDir = await this.getPathToLoadTestDir(timeOfTestRun);
    } catch (err) {
      pathToLoadTestDir = await this.getClosestPathToLoadTestDir(timeOfTestRun);
    }
    const pathToMetricsJson = join(pathToLoadTestDir, 'metrics.json');
    return pathToMetricsJson;
  }

  /**
   * @param {String|Int} timeOfTestRun in 'yyyymmddHHMMss' format
   */
  async getPathToProfilingFile(timeOfTestRun) {
    const pathToLoadTestDir = join(this.loadTestPath, String(timeOfTestRun));
    if (this.language == 'nodejs') {
      const pathToProfilingJson = join(pathToLoadTestDir, 'profiling.json');
      if (await fs.exists(pathToProfilingJson)) {
        return pathToProfilingJson; 
      }
      throw new ProjectMetricsError('PROFILING_NOT_FOUND', this.name, `profiling.json was not found for load run ${timeOfTestRun}`);
    } else if (this.language == 'java') {
      let fileName = await isHcdSaved(pathToLoadTestDir)
      if (fileName !== false) {
        return join(pathToLoadTestDir, fileName)
      } 

      try {
        const projectRoot = join("home", "default", "app");
        const relativePathToFile = join("load-test", timeOfTestRun);
        // find the actual name of the hcd file from the docker container
        cwUtils.findHCDFile(this, join(projectRoot,relativePathToFile));
        if (this.hcdName == undefined  || this.hcdName == "") {
          throw new ProjectMetricsError('HCD_NOT_FOUND', this.name, `.hcd file has not been saved for load run ${timeOfTestRun}`);
        }
        log.info(`Attempting to copy profiling file ${this.hcdName} for ${this.name} load run ${timeOfTestRun}`)

        let originHCDPath = join(projectRoot, relativePathToFile, this.hcdName);
        let destinationHCDPath = join(this.loadTestPath, timeOfTestRun, this.hcdName);
        log.debug(`getPathToProfilingFile originHCDPath=${originHCDPath}.`);
        log.debug(`getPathToProfilingFile destinationHCDPath=${destinationHCDPath}.`);

        await cwUtils.copyFileFromContainer(this, originHCDPath, destinationHCDPath);
      } catch (error) {
        throw new ProjectMetricsError('DOCKER_CP', this.name, error.message);
      }
      log.info(`${this.name} hcd file from run ${timeOfTestRun} saved to pfe`);   
      return join(pathToLoadTestDir, this.hcdName);
    }
    return null
  }

  /**
   * 
   * @param {String|Int} timeOfTestRun in 'yyyymmddHHMMss' format
   */
  async removeProfilingData(timeOfTestRun) {
    const profilingPath = join(this.loadTestPath, timeOfTestRun);
    await rimraf.sync(profilingPath);
  }

  /**
   * @param {String|Int} timeOfTestRun in 'yyyymmddHHMMss' format
   * @param {String} newDescription
   */
  async updateMetricsDescription(timeOfTestRun, newDescription) {
    const pathToMetricsJson = await this.getPathToMetricsFile(timeOfTestRun);
    const metrics = await fs.readJson(pathToMetricsJson);
    metrics.desc = newDescription;
    await fs.writeJson(pathToMetricsJson, metrics, { spaces: '  ' });
  }


  /**
   * Function to return comparison (metric deltas) for this project. We obtain the deltas by
   * finding and examining metrics.json files for the project. These are the summary files
   * that the jmeter support creates for each load test run. If there were less than two load
   * test runs for this project, or there were problems finding or reading a metrics.json file
   * we throw a ProjectError exception back to the API in server.js.
   * @return {JSON} the comparison
   */
  async getComparison() {
    let comparison = [];
    // Look for project load-test directories and check for metrics.json files

    let loadTestDirectories = await getLoadTestDirs(this.loadTestPath);
    if (loadTestDirectories.length < 2) {
      log.warn(`getComparison: unable to find two snapshots for project ${this.name} id: ${this.projectID}`);
      throw new ProjectError('NOT_ENOUGH_SNAPSHOTS', this.name);
    }
    loadTestDirectories.sort();
    let metricsFile1Name = loadTestDirectories[loadTestDirectories.length - 2] //Second most recent metrics file
    let metricsFile2Name = loadTestDirectories[loadTestDirectories.length - 1] //Most recent metrics file
    // Locate most recent pair of metric files, then construct JSON object showing % change for each value
    let filePath = join(this.loadTestPath, metricsFile1Name, 'metrics.json');
    let metricsFile1 = await fs.readJson(filePath);
    filePath = join(this.loadTestPath, metricsFile2Name, 'metrics.json');
    let metricsFile2 = await fs.readJson(filePath);

    log.info(`Creating metrics comparison for load-test runs ${metricsFile1Name} and ${metricsFile2Name}`);

    // Loop through objects of metrics file 1
    for (let dataType in metricsFile1) {
      // If the data type is unrecognised, then just skip it
      if (METRIC_TYPES.indexOf(dataType) < 0 && dataType != 'httpUrls') {
        continue;
      }
      let deltas = {};
      // We only want to create the comparison if the object is present in both files and is a data object (i.e. ignore id, startTime, endTime etc.)
      if (metricsFile1[dataType] instanceof Object && dataType in metricsFile2) {
        // If we are getting httpurl data, we want to get the average throughput across all URLs
        if (dataType === 'httpUrls') {
          let metricsFile1Avg = getOverallAvgResTime(metricsFile1);
          let metricsFile2Avg = getOverallAvgResTime(metricsFile2);

          //Create delta % and add it to the delta object
          let deltaAvgHttpResTime = {
            "averageHttpResponseTime": ((metricsFile2Avg - metricsFile1Avg) / metricsFile1Avg) * 100
          }
          comparison.push({ type: 'http', delta: deltaAvgHttpResTime });
        } else {
          // Perform delta calculations for all data labels for the given data type e.g. data type = cpu, data label = systemMean
          for (let dataLabel in metricsFile1[dataType].data) {
            // Get data out of metric file for given label
            let metric1 = metricsFile1[dataType].data[dataLabel];
            let metric2 = metricsFile2[dataType].data[dataLabel];
            // Calculate delta and add it to array of deltas as a %
            deltas[dataLabel] = ((metric2 - metric1) / metric1) * 100;
          }
          //Add deltas to list of other deltas
          comparison.push({ type: dataType, delta: deltas });
        }
      }
      // If the data is only present in metrics file 1 or is an invalid object, we can't compare
      else {
        log.warn(`Unable to calculate '${dataType}' comparison for project ${this.name} - the data in load-test run ${metricsFile2Name} may be missing or may not be an object`);
        comparison.push({ type: dataType, delta: "Data unavailable" });
      }
    }

    // Check the second file for any data types that may be missing from the first file and declare them unavailable
    for (let dataType of Object.keys(metricsFile2)) {
      if (metricsFile2[dataType] instanceof Object && !(dataType in metricsFile1)) {
        log.warn(`Unable to calculate '${dataType}'' comparison for project ${this.name} - the data in load-test run ${metricsFile1Name} may be missing or may not be an object`);
        comparison.push({ type: dataType, "delta": "Data unavailable" });
      }
    }
    log.info(`Metrics comparison created`);
    return comparison;
  }

  /**
   * Start streaming updates to a log via the ui socket.
   * If we are already streaming it, stop, reset and restart
   * from the beginning as the request may be from a new client.
   * Existing clients should see and honour the reset flag
   * so won't show data they've received already twice.
   *
   * @param uiSocket the UI socket for the user
   * @param logType the log type (e.g. build or app)
   * @param logOrigin the origin of the log
   * @param logName the short name of the log
   * @param logFile the log file name (if file based)
   */
  startStreamingLog(uiSocket, logType, logOrigin, logName, logFile) {
    let logStreamKey = `${logType}-${logName}`;
    let logStream = this.logStreams[logStreamKey];
    if (logStream) {
      logStream.stop();
      logStream.resetStream();
    } else {
      logStream = LogStream.createLogStream(this, uiSocket, logType, logOrigin, logName, logFile);
      this.logStreams[logStreamKey] = logStream;
    }
    logStream.streamLog();
  }

  /**
   * Stop streaming updates to a log via the ui socket.
   *
   * @param logType the log type of the log to stop streaming
   * @param logName the name of the log to stop streaming
   */
  stopStreamingLog(logType, logName) {
    let logStreamKey = `${logType}-${logName}`;
    if (this.logStreams[logStreamKey]) {
      let logStream = this.logStreams[logStreamKey];
      delete this.logStreams[logStreamKey];
      logStream.stop();
    }
  }

  /**
   * Stop streaming updates for all logs belonging to this
   * project.
   */
  stopStreamingAllLogs() {
    for (let logStreamKey of Object.keys(this.logStreams)) {
      let logStream = this.logStreams[logStreamKey];
      delete this.logStreams[logStreamKey];
      logStream.stop();
    }
  }

  /**
   * Set the reset flag on a log stream so the UI knows to clear
   * the current output.
   * @param logType
   */
  resetLogStream(logType) {
    for( let logStreamKey of Object.keys(this.logStreams) ) {
      if (logStreamKey.startsWith(logType)) {
        this.logStreams[logStreamKey].resetStream();
      }
    }
  }

  /**
   * @returns {Boolean} is the project open
   */
  isOpen() {
    return (this.state === STATES.open);
  }

  /**
   * @returns {Boolean} is the project closed
   */
  isClosed() {
    return (this.state === STATES.closed);
  }

  /**
   * @returns {Boolean} is the project validating
   */
  isValidating() {
    return (this.state === STATES.validating);
  }

  /**
   * @returns {Boolean} is the project in the closing process
   */
  isClosing() {
    return (this.action === STATES.closing);
  }

  /**
   * @returns {Boolean} is the project in the deletion process
   */
  isDeleting() {
    return (this.action === STATES.deleting);
  }

  async getLoadTestConfig() {
    let config = "";
    const pathToConfigFile = join(this.loadTestPath, 'config.json');
    if (await fs.pathExists(pathToConfigFile)) {
      config = await fs.readJson(pathToConfigFile);
      if (config) {
        log.debug(`getLoadTestConfig: returning ${JSON.stringify(config)}`);
      } else {
        log.warn(`getLoadTestConfig: unable to read config`);
      }
    } else {
      config = this.createLoadTestConfigFile();
    }
    return config;
  }

  async writeNewLoadTestConfigFile(configOptions) {
    await fs.ensureDir(this.loadTestPath);
    const filePath = join(this.loadTestPath, 'config.json');
    await fs.writeJson(filePath, configOptions, {spaces: '  '});
  }

  async createLoadTestConfigFile() {
    let contextRoot = '/';
    if (this.contextRoot) {
      contextRoot += this.contextRoot;
    }
    let config = {
      path: contextRoot,
      requestsPerSecond: "1",
      concurrency: "1",
      maxSeconds: "180"
    };
    await fs.ensureDir(this.loadTestPath);
    const filePath = join(this.loadTestPath, 'config.json');
    await fs.writeJson(filePath, config, {spaces: '  '});
    return config;
  }

  /**
   * Resolves the given path against the project's monitor path.
   * The path is unchanged if it is already absolute.
   *
   * @param {String} path
   * @returns {String} an absolute path
   */
  resolveMonitorPath(path) {
    return isAbsolute(path) ? cwUtils.convertFromWindowsDriveLetter(path) : join(this.pathToMonitor, path);
  }

  // Project Link wrappers so they can access the writeInformationFile function
  async createLink(newLink) {
    await this.links.add(newLink);
    return this.writeInformationFile();
  }

  async updateLink(envName, newEnvName, newProjectURL) {
    await this.links.update(envName, newEnvName, newProjectURL);
    return this.writeInformationFile();
  }

  async deleteLink(envName) {
    await this.links.delete(envName);
    return this.writeInformationFile();
  }
}

/**
 * @param {string} pathToLoadTestDir
 */
async function isHcdSaved(pathToLoadTestDir) {
  try {
    await fs.access(pathToLoadTestDir);
  } catch (error) {
    return false;
  }
  const files = await fs.readdir(pathToLoadTestDir);
  for (let i = 0; i < files.length; i++) {
    if (extname(files[i]) == '.hcd') {
      return files[i];
    }
  } 
  return false
}

/**
 * Function to retrieve all load test directories created by Jmeter runs.
 * These should contain a metrics.json file, so we return only those containing this file.
 * @param loadTestPath, the path of the top-level load-test directory (e.g. workspace/projectname/load-test)
 * @return {[String]} names of load-test directories that contain metrics.json files
 */
async function getLoadTestDirs(loadTestPath){
  let entries;
  try {
    entries = await fs.readdir(loadTestPath);
  } catch(err) {
    log.error(`load test directory does not exist ${loadTestPath}`);
    throw new ProjectError('LOAD_TEST_DIR_ERROR', null);
  }
  let loadTestDirectories = [];
  for (let i=0; i < entries.length; i++) {
    const fstats = await fs.lstat(join(loadTestPath, entries[i]));
    // The load test runs are in directories with numeric timestamp names
    if (fstats.isDirectory() && !isNaN(entries[i])) {
      // Now check there is a metrics.json file in the directory
      try {
        await fs.access(join(loadTestPath, entries[i], 'metrics.json'));
        loadTestDirectories.push(entries[i]); // add it to our list
      } catch(err) {
        log.error(`No metrics.json found in directory ${join(loadTestPath, entries[i])}`);
      }
    }
  }

  return loadTestDirectories;
}

/**
 * Functon to calculate the overall average of all averageResponseTimes for a set of httpUrl data in a given metrics file.
 * @param metricsFile, the given metrics file JSON object containing the httpUrl data
 * @return the average of all averageResponseTimes for all URLs in a metrics file
 */
function getOverallAvgResTime(metricsFile) {
  // If we don't have httpUrl data, throw an error
  if (!metricsFile || !metricsFile.hasOwnProperty('httpUrls') 
    || !metricsFile.httpUrls || !metricsFile['httpUrls'].data) {
    throw new ProjectError('NOT_FOUND', null)
  }
  let avgResTime = 0;
  for (let urlEntry of metricsFile['httpUrls'].data) {
    avgResTime += urlEntry.averageResponseTime;
  }
  return avgResTime / metricsFile['httpUrls'].data.length;
}

// Make the states enum accessible from the Projects class.
module.exports.STATES = STATES;
module.exports.CW_SETTINGS_PROPERTIES = CW_SETTINGS_PROPERTIES;
