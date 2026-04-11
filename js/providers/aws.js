'use strict';
window.StatusDash = window.StatusDash || {};
window.StatusDash.providers = window.StatusDash.providers || {};

/** Amazon Web Services — service health RSS feed */
window.StatusDash.providers.aws = (() => {
  const ID    = 'aws';
  const NAME  = 'Amazon Web Services';
  const COLOR = '#FF9900';
  const URL   = 'https://status.aws.amazon.com/rss/all.rss';

  // Service code → human name
  const SVC = {
    ec2:'Amazon EC2', s3:'Amazon S3', rds:'Amazon RDS', lambda:'AWS Lambda',
    dynamodb:'Amazon DynamoDB', cloudfront:'Amazon CloudFront', route53:'Amazon Route 53',
    ecs:'Amazon ECS', eks:'Amazon EKS', elasticache:'Amazon ElastiCache',
    redshift:'Amazon Redshift', ses:'Amazon SES', sns:'Amazon SNS', sqs:'Amazon SQS',
    iam:'AWS IAM', cloudwatch:'Amazon CloudWatch', elb:'Elastic Load Balancing',
    vpc:'Amazon VPC', apigateway:'Amazon API Gateway', sagemaker:'Amazon SageMaker',
    kinesis:'Amazon Kinesis', emr:'Amazon EMR', glue:'AWS Glue', athena:'Amazon Athena',
    cloudformation:'AWS CloudFormation', ssm:'AWS Systems Manager',
    secretsmanager:'AWS Secrets Manager', kms:'AWS KMS', waf:'AWS WAF',
    shield:'AWS Shield', guardduty:'Amazon GuardDuty', inspector:'Amazon Inspector',
    cognito:'Amazon Cognito', neptune:'Amazon Neptune', documentdb:'Amazon DocumentDB',
    msk:'Amazon MSK', opensearch:'Amazon OpenSearch', eventbridge:'Amazon EventBridge',
    codecommit:'AWS CodeCommit', codepipeline:'AWS CodePipeline',
    codebuild:'AWS CodeBuild', codedeploy:'AWS CodeDeploy',
    directconnect:'AWS Direct Connect', backup:'AWS Backup',
    multipleservices:'Multiple Services', generalservices:'General AWS Services',
  };

  // Region code → friendly name (sorted by length desc for matching)
  const REGIONS = {
    'us-east-1':'US East (N. Virginia)', 'us-east-2':'US East (Ohio)',
    'us-west-1':'US West (N. California)', 'us-west-2':'US West (Oregon)',
    'ca-central-1':'Canada (Central)', 'ca-west-1':'Canada West (Calgary)',
    'eu-west-1':'Europe (Ireland)', 'eu-west-2':'Europe (London)',
    'eu-west-3':'Europe (Paris)', 'eu-central-1':'Europe (Frankfurt)',
    'eu-central-2':'Europe (Zurich)', 'eu-north-1':'Europe (Stockholm)',
    'eu-south-1':'Europe (Milan)', 'eu-south-2':'Europe (Spain)',
    'ap-northeast-1':'Asia Pacific (Tokyo)', 'ap-northeast-2':'Asia Pacific (Seoul)',
    'ap-northeast-3':'Asia Pacific (Osaka)', 'ap-southeast-1':'Asia Pacific (Singapore)',
    'ap-southeast-2':'Asia Pacific (Sydney)', 'ap-southeast-3':'Asia Pacific (Jakarta)',
    'ap-southeast-4':'Asia Pacific (Melbourne)', 'ap-south-1':'Asia Pacific (Mumbai)',
    'ap-south-2':'Asia Pacific (Hyderabad)', 'ap-east-1':'Asia Pacific (Hong Kong)',
    'me-south-1':'Middle East (Bahrain)', 'me-central-1':'Middle East (UAE)',
    'sa-east-1':'South America (São Paulo)', 'af-south-1':'Africa (Cape Town)',
    'il-central-1':'Israel (Tel Aviv)',
    'us-gov-east-1':'GovCloud (US-East)', 'us-gov-west-1':'GovCloud (US-West)',
  };

  // Sort region codes longest-first so longer codes match before shorter ones
  const REGION_CODES = Object.keys(REGIONS).sort((a, b) => b.length - a.length);

  const DASH_RULES = [
    ['Compute',        /^(ec2|ecs|eks|lambda|batch|lightsail|elasticbeanstalk|apprunner|workspaces)/],
    ['Storage',        /^(s3|ebs|efs|glacier|storagegateway|backup|fsx)/],
    ['Database',       /^(rds|dynamodb|aurora|redshift|elasticache|neptune|documentdb|opensearch|memorydb)/],
    ['Networking',     /^(vpc|route53|cloudfront|elb|directconnect|appmesh|globalaccelerator|servicediscovery)/],
    ['Security',       /^(iam|cognito|kms|secretsmanager|waf|shield|guardduty|inspector|securityhub|acm)/],
    ['Integration',    /^(sns|sqs|ses|apigateway|kinesis|msk|eventbridge|appsync|stepfunctions|swf)/],
    ['AI & Analytics', /^(sagemaker|comprehend|rekognition|textract|transcribe|translate|forecast|glue|athena|emr|quicksight|bedrock)/],
    ['Management',     /^(cloudwatch|cloudtrail|cloudformation|ssm|config|organizations|budgets|costexplorer|servicecatalog)/],
  ];

  function _dashboard(code) {
    for (const [cat, re] of DASH_RULES) if (re.test(code)) return cat;
    return 'Other';
  }

  /**
   * AWS GUIDs encode service + region:
   *   https://status.aws.amazon.com/#s3-us-east-1_1234567890
   *   https://status.aws.amazon.com/#multipleservices-eu-central-1_1234567890
   */
  function _parseGuid(guid) {
    const anchor = (guid.split('#')[1] || '').split('_')[0];
    for (const code of REGION_CODES) {
      if (anchor.endsWith(`-${code}`)) {
        const svcCode = anchor.slice(0, anchor.length - code.length - 1);
        return { svcCode: svcCode || 'generalservices', regionCode: code };
      }
    }
    return { svcCode: anchor || 'generalservices', regionCode: '' };
  }

  function _slug(title) {
    const t = (title || '').toLowerCase();
    // AWS brackets status at start: "[RESOLVED]", "[MONITORING]", "[INVESTIGATING]"
    if (/^\[resolv/.test(t) || /resolv|restor|recovery complete|service is operating normally|operating normally/.test(t)) return 'resolved';
    if (/^\[monitor/.test(t) || /\bmonitoring\b|recovery in progress|improving|partially/.test(t)) return 'monitoring';
    if (/^\[identified/.test(t) || /service impact|degraded|performance issue|partial/.test(t))    return 'identified';
    // No status prefix = still active/investigating
    return 'investigating';
  }

  function parse(xml) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (doc.querySelector('parsererror')) throw new Error('AWS: malformed RSS');
    const { isSafeUrl } = window.StatusDash.utils;
    return [...doc.querySelectorAll('item')].map(item => {
      const title   = item.querySelector('title')?.textContent.trim() || '';
      const desc    = item.querySelector('description')?.textContent.trim() || '';
      const link    = item.querySelector('link')?.textContent.trim() || '';
      const pubDate = item.querySelector('pubDate')?.textContent || '';
      const guid    = item.querySelector('guid')?.textContent || `aws-${Math.random()}`;
      const { svcCode, regionCode } = _parseGuid(guid);
      const svcName    = SVC[svcCode]
        || svcCode.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const regionName = REGIONS[regionCode]
        || (regionCode ? regionCode.toUpperCase() : 'Multiple Regions');
      return {
        id: `aws:${guid}`,
        provider: ID, providerName: NAME, providerColor: COLOR,
        service:   svcName,
        region:    regionName,
        reference: guid.split('_')[1] || '',
        dashboard: _dashboard(svcCode),
        slug:      _slug(title),
        link:      isSafeUrl(link) ? link : 'https://status.aws.amazon.com/',
        publishedAt: pubDate ? new Date(pubDate) : new Date(0),
        updates: desc ? [{ time: pubDate, status: title.split(':')[0] || '', text: desc }] : [],
      };
    });
  }

  async function fetchIncidents(force = false) {
    const xml = await window.StatusDash.fetcher.fetchXml(URL, ID, force);
    return parse(xml);
  }

  return { id: ID, name: NAME, color: COLOR, fetchIncidents };
})();
