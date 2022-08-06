import * as cdk from 'aws-cdk-lib';
import * as appmesh from 'aws-cdk-lib/aws-appmesh';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { SupabaseDatabase } from './supabase-db';
import { SupabaseMailBase } from './supabase-mail';

interface SupabaseServiceProps {
  cluster: ecs.ICluster;
  containerDefinition: ecs.ContainerDefinitionOptions;
  cpu?: number;
  memory?: number;
  cpuArchitecture?: ecs.CpuArchitecture;
  withLoadBalancer?: 'Network'|'Application';
  mesh?: appmesh.Mesh;
}

export class SupabaseService extends Construct {
  listenerPort: number;
  internalDnsName: string;
  service: ecs.FargateService;
  virtualService?: appmesh.VirtualService;
  virtualNode?: appmesh.VirtualNode;
  loadBalancer?: elb.BaseLoadBalancer;

  constructor(scope: Construct, id: string, props: SupabaseServiceProps) {
    super(scope, id);

    const serviceName = id.toLowerCase();
    const { cluster, containerDefinition, cpu, memory, withLoadBalancer, mesh } = props;
    const cpuArchitecture = props.cpuArchitecture || ecs.CpuArchitecture.ARM64;
    const vpc = cluster.vpc;

    this.listenerPort = containerDefinition.portMappings![0].containerPort;

    const proxyConfiguration = (typeof mesh == 'undefined') ? undefined : new ecs.AppMeshProxyConfiguration({
      containerName: 'envoy',
      properties: {
        ignoredUID: 1337,
        ignoredGID: 1338,
        appPorts: [this.listenerPort],
        proxyIngressPort: 15000,
        proxyEgressPort: 15001,
        //egressIgnoredPorts: [2049], // EFS
        egressIgnoredIPs: ['169.254.170.2', '169.254.169.254'],
      },
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      cpu,
      memoryLimitMiB: memory,
      runtimePlatform: { cpuArchitecture },
      proxyConfiguration,
    });

    const logGroup = new logs.LogGroup(this, 'Logs', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_MONTH,
    });

    const logging = new ecs.AwsLogDriver({ logGroup, streamPrefix: 'ecs' });

    const appContainer = taskDefinition.addContainer('app', {
      ...containerDefinition,
      essential: true,
      logging,
    });
    appContainer.addUlimits({ name: ecs.UlimitName.NOFILE, softLimit: 65536, hardLimit: 65536 });

    this.service = new ecs.FargateService(this, 'Svc', {
      cluster,
      taskDefinition,
      circuitBreaker: { rollback: true },
      capacityProviderStrategies: [
        { capacityProvider: 'FARGATE', base: 1, weight: 1 },
        { capacityProvider: 'FARGATE_SPOT', base: 0, weight: 0 },
      ],
      cloudMapOptions: {
        dnsTtl: cdk.Duration.seconds(10),
        name: serviceName,
      },
      healthCheckGracePeriod: (typeof withLoadBalancer == 'undefined') ? undefined : cdk.Duration.seconds(10),
    });

    this.internalDnsName = `${this.service.cloudMapService?.serviceName}.${this.service.cloudMapService?.namespace.namespaceName}`;

    if (withLoadBalancer == 'Network') {
      const vpcInternal = ec2.Peer.ipv4(cluster.vpc.vpcCidrBlock);
      const healthCheckPort = ec2.Port.tcp(containerDefinition.portMappings!.slice(-1)[0].containerPort);
      this.service.connections.allowFrom(vpcInternal, healthCheckPort, 'NLB healthcheck');

      const targetGroup = new elb.NetworkTargetGroup(this, 'TargetGroup', {
        port: 80,
        targets: [
          this.service.loadBalancerTarget({ containerName: 'app' }),
        ],
        healthCheck: {
          port: healthCheckPort.toString(),
          interval: cdk.Duration.seconds(10),
        },
        deregistrationDelay: cdk.Duration.seconds(30),
        preserveClientIp: true,
        vpc,
      });
      const loadBalancer = new elb.NetworkLoadBalancer(this, 'LoadBalancer', { internetFacing: true, vpc });
      loadBalancer.addListener('Listener', {
        port: 80,
        defaultTargetGroups: [targetGroup],
      });
      this.loadBalancer = loadBalancer;
    } else if (withLoadBalancer == 'Application') {
      const targetGroup = new elb.ApplicationTargetGroup(this, 'TargetGroup', {
        port: 80,
        targets: [
          this.service.loadBalancerTarget({ containerName: 'app' }),
        ],
        healthCheck: {
          interval: cdk.Duration.seconds(10),
          timeout: cdk.Duration.seconds(5),
        },
        deregistrationDelay: cdk.Duration.seconds(30),
        vpc,
      });
      const loadBalancer = new elb.ApplicationLoadBalancer(this, 'LoadBalancer', { internetFacing: true, vpc });
      loadBalancer.addListener('Listener', {
        port: 80,
        defaultTargetGroups: [targetGroup],
      });
      this.loadBalancer = loadBalancer;
    }

    if (typeof mesh != 'undefined') {
      this.virtualNode = new appmesh.VirtualNode(this, 'VirtualNode', {
        virtualNodeName: id,
        serviceDiscovery: appmesh.ServiceDiscovery.cloudMap(this.service.cloudMapService!),
        listeners: [appmesh.VirtualNodeListener.http({ port: this.listenerPort })],
        accessLog: appmesh.AccessLog.fromFilePath('/dev/stdout'),
        mesh,
      });

      this.virtualService = new appmesh.VirtualService(this, 'VirtualService', {
        virtualServiceName: `${serviceName}.${cluster.defaultCloudMapNamespace?.namespaceName}`,
        virtualServiceProvider: appmesh.VirtualServiceProvider.virtualNode(this.virtualNode),
      });

      taskDefinition.taskRole.addManagedPolicy({ managedPolicyArn: 'arn:aws:iam::aws:policy/AWSAppMeshEnvoyAccess' });
      taskDefinition.taskRole.addManagedPolicy({ managedPolicyArn: 'arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess' });

      const proxyContainer = taskDefinition.addContainer('envoy', {
        image: ecs.ContainerImage.fromRegistry('public.ecr.aws/appmesh/aws-appmesh-envoy:v1.22.2.0-prod'),
        user: '1337',
        cpu: 80,
        memoryReservationMiB: 128,
        essential: true,
        healthCheck: {
          command: ['CMD-SHELL', 'curl -s http://localhost:9901/server_info | grep state | grep -q LIVE'],
          interval: cdk.Duration.seconds(5),
          timeout: cdk.Duration.seconds(2),
          startPeriod: cdk.Duration.seconds(10),
          retries: 3,
        },
        environment: {
          APPMESH_VIRTUAL_NODE_NAME: `mesh/${mesh.meshName}/virtualNode/${this.virtualNode.virtualNodeName}`,
          ENVOY_ADMIN_ACCESS_LOG_FILE: '/dev/null',
          ENABLE_ENVOY_XRAY_TRACING: '1',
          XRAY_SAMPLING_RATE: '1.00',
        },
        logging,
      });
      proxyContainer.addUlimits({ name: ecs.UlimitName.NOFILE, hardLimit: 1024000, softLimit: 1024000 });

      appContainer.addContainerDependencies({
        container: proxyContainer,
        condition: ecs.ContainerDependencyCondition.HEALTHY,
      });

      taskDefinition.addContainer('xray-daemon', {
        image: ecs.ContainerImage.fromRegistry('public.ecr.aws/xray/aws-xray-daemon:latest'),
        user: '1337',
        cpu: 16,
        memoryReservationMiB: 64,
        essential: true,
        portMappings: [{
          containerPort: 2000,
          protocol: ecs.Protocol.UDP,
        }],
        healthCheck: {
          command: ['CMD', '/xray', '--version', '||', 'exit 1'], // https://github.com/aws/aws-xray-daemon/issues/9
          interval: cdk.Duration.seconds(5),
          timeout: cdk.Duration.seconds(2),
          startPeriod: cdk.Duration.seconds(10),
          retries: 3,
        },
        logging,
      });

    }

  }
  addBackend(backend: SupabaseService) {
    this.service.connections.allowTo(backend.service, ec2.Port.tcp(backend.listenerPort));
    if (typeof backend.virtualService != 'undefined') {
      this.virtualNode?.addBackend(appmesh.Backend.virtualService(backend.virtualService));
    }
  }

  addDatabaseBackend(backend: SupabaseDatabase) {
    this.service.connections.allowToDefaultPort(backend);
    if (typeof backend.virtualService != 'undefined') {
      this.virtualNode?.addBackend(appmesh.Backend.virtualService(backend.virtualService));
    }
  }

  addExternalBackend(backend: SupabaseMailBase) {
    if (typeof backend.virtualService != 'undefined') {
      this.virtualNode?.addBackend(appmesh.Backend.virtualService(backend.virtualService));
    }
  }
}