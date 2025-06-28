# Helm provider configuration
provider "helm" {
  kubernetes {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
    
    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args = ["eks", "get-token", "--cluster-name", module.eks.cluster_name]
    }
  }
}

# Kubernetes provider configuration
provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
  
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args = ["eks", "get-token", "--cluster-name", module.eks.cluster_name]
  }
}

# Namespaces
resource "kubernetes_namespace" "observability" {
  count = var.enable_monitoring ? 1 : 0
  
  metadata {
    name = "observability"
    labels = {
      name = "observability"
    }
  }
}

resource "kubernetes_namespace" "ingress_nginx" {
  metadata {
    name = "ingress-nginx"
    labels = {
      name = "ingress-nginx"
    }
  }
}

resource "kubernetes_namespace" "cert_manager" {
  metadata {
    name = "cert-manager"
    labels = {
      name = "cert-manager"
    }
  }
}

# AWS Load Balancer Controller
module "aws_load_balancer_controller_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "5.30.0"

  role_name = "${local.name}-${local.env}-aws-load-balancer-controller"

  attach_load_balancer_controller_policy = true

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:aws-load-balancer-controller"]
    }
  }

  tags = local.common_tags
}

resource "helm_release" "aws_load_balancer_controller" {
  name       = "aws-load-balancer-controller"
  repository = "https://aws.github.io/eks-charts"
  chart      = "aws-load-balancer-controller"
  namespace  = "kube-system"
  version    = "1.6.1"

  set {
    name  = "clusterName"
    value = module.eks.cluster_name
  }

  set {
    name  = "serviceAccount.create"
    value = "true"
  }

  set {
    name  = "serviceAccount.name"
    value = "aws-load-balancer-controller"
  }

  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.aws_load_balancer_controller_irsa.iam_role_arn
  }

  depends_on = [module.eks]
}

# Prometheus Stack
resource "helm_release" "kube_prometheus_stack" {
  count = var.enable_monitoring ? 1 : 0
  
  name       = "kube-prometheus-stack"
  repository = "https://prometheus-community.github.io/helm-charts"
  chart      = "kube-prometheus-stack"
  namespace  = kubernetes_namespace.observability[0].metadata[0].name
  version    = "51.3.0"

  values = [
    templatefile("${path.module}/helm-values/prometheus-stack.yaml", {
      cluster_name      = module.eks.cluster_name
      environment       = var.environment
      alert_email       = var.alert_email
      slack_webhook_url = var.alert_slack_webhook
      retention_days    = var.environment == "production" ? 30 : 7
      storage_size      = var.environment == "production" ? "100Gi" : "20Gi"
    })
  ]

  set {
    name  = "prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues"
    value = "false"
  }

  set {
    name  = "prometheus.prometheusSpec.podMonitorSelectorNilUsesHelmValues"
    value = "false"
  }

  depends_on = [module.eks]
}

# Loki Stack for log aggregation
resource "helm_release" "loki_stack" {
  count = var.enable_monitoring ? 1 : 0
  
  name       = "loki-stack"
  repository = "https://grafana.github.io/helm-charts"
  chart      = "loki-stack"
  namespace  = kubernetes_namespace.observability[0].metadata[0].name
  version    = "2.9.11"

  values = [
    templatefile("${path.module}/helm-values/loki-stack.yaml", {
      s3_bucket     = aws_s3_bucket.logs.id
      s3_region     = var.aws_region
      iam_role_arn  = module.loki_irsa[0].iam_role_arn
      retention_days = var.environment == "production" ? 30 : 7
    })
  ]

  set {
    name  = "promtail.enabled"
    value = "true"
  }

  set {
    name  = "grafana.enabled"
    value = "false" # Using Grafana from kube-prometheus-stack
  }

  depends_on = [module.eks, kubernetes_namespace.observability]
}

# IAM role for Loki
module "loki_irsa" {
  count = var.enable_monitoring ? 1 : 0
  
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "5.30.0"

  role_name = "${local.name}-${local.env}-loki"

  role_policy_arns = {
    policy = aws_iam_policy.loki[0].arn
  }

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["observability:loki"]
    }
  }

  tags = local.common_tags
}

resource "aws_iam_policy" "loki" {
  count = var.enable_monitoring ? 1 : 0
  
  name        = "${local.name}-${local.env}-loki"
  description = "IAM policy for Loki to access S3"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:ListBucket",
          "s3:GetBucketLocation"
        ]
        Resource = aws_s3_bucket.logs.arn
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject"
        ]
        Resource = "${aws_s3_bucket.logs.arn}/*"
      }
    ]
  })
}

# OpenTelemetry Collector
resource "helm_release" "opentelemetry_collector" {
  count = var.enable_monitoring ? 1 : 0
  
  name       = "opentelemetry-collector"
  repository = "https://open-telemetry.github.io/opentelemetry-helm-charts"
  chart      = "opentelemetry-collector"
  namespace  = kubernetes_namespace.observability[0].metadata[0].name
  version    = "0.73.1"

  values = [
    templatefile("${path.module}/helm-values/otel-collector.yaml", {
      cluster_name = module.eks.cluster_name
      environment  = var.environment
    })
  ]

  depends_on = [module.eks, kubernetes_namespace.observability]
}

# NGINX Ingress Controller
resource "helm_release" "ingress_nginx" {
  name       = "ingress-nginx"
  repository = "https://kubernetes.github.io/ingress-nginx"
  chart      = "ingress-nginx"
  namespace  = kubernetes_namespace.ingress_nginx.metadata[0].name
  version    = "4.8.3"

  values = [
    templatefile("${path.module}/helm-values/ingress-nginx.yaml", {
      environment = var.environment
    })
  ]

  set {
    name  = "controller.service.type"
    value = "LoadBalancer"
  }

  set {
    name  = "controller.service.annotations.service\\.beta\\.kubernetes\\.io/aws-load-balancer-type"
    value = "nlb"
  }

  depends_on = [module.eks, helm_release.aws_load_balancer_controller]
}

# Cert Manager
resource "helm_release" "cert_manager" {
  name       = "cert-manager"
  repository = "https://charts.jetstack.io"
  chart      = "cert-manager"
  namespace  = kubernetes_namespace.cert_manager.metadata[0].name
  version    = "1.13.1"

  set {
    name  = "installCRDs"
    value = "true"
  }

  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.cert_manager_irsa.iam_role_arn
  }

  depends_on = [module.eks]
}

# IAM role for Cert Manager (for Route53 DNS validation)
module "cert_manager_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "5.30.0"

  role_name = "${local.name}-${local.env}-cert-manager"

  attach_cert_manager_policy = true
  cert_manager_hosted_zone_arns = [
    "arn:aws:route53:::hostedzone/*"
  ]

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["cert-manager:cert-manager"]
    }
  }

  tags = local.common_tags
}

# Cluster Autoscaler
module "cluster_autoscaler_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "5.30.0"

  role_name = "${local.name}-${local.env}-cluster-autoscaler"

  attach_cluster_autoscaler_policy = true
  cluster_autoscaler_cluster_ids   = [module.eks.cluster_name]

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:cluster-autoscaler"]
    }
  }

  tags = local.common_tags
}

resource "helm_release" "cluster_autoscaler" {
  count = var.enable_auto_scaling ? 1 : 0
  
  name       = "cluster-autoscaler"
  repository = "https://kubernetes.github.io/autoscaler"
  chart      = "cluster-autoscaler"
  namespace  = "kube-system"
  version    = "9.29.3"

  set {
    name  = "autoDiscovery.clusterName"
    value = module.eks.cluster_name
  }

  set {
    name  = "rbac.serviceAccount.name"
    value = "cluster-autoscaler"
  }

  set {
    name  = "rbac.serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.cluster_autoscaler_irsa.iam_role_arn
  }

  set {
    name  = "extraArgs.balance-similar-node-groups"
    value = "true"
  }

  set {
    name  = "extraArgs.skip-nodes-with-system-pods"
    value = "false"
  }

  depends_on = [module.eks]
}

# Metrics Server (required for HPA)
resource "helm_release" "metrics_server" {
  name       = "metrics-server"
  repository = "https://kubernetes-sigs.github.io/metrics-server/"
  chart      = "metrics-server"
  namespace  = "kube-system"
  version    = "3.11.0"

  set {
    name  = "args[0]"
    value = "--kubelet-insecure-tls"
  }

  depends_on = [module.eks]
}

# External Secrets Operator
resource "helm_release" "external_secrets" {
  name       = "external-secrets"
  repository = "https://charts.external-secrets.io"
  chart      = "external-secrets"
  namespace  = "kube-system"
  version    = "0.9.5"

  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.external_secrets_irsa.iam_role_arn
  }

  depends_on = [module.eks]
}

# IAM role for External Secrets
module "external_secrets_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "5.30.0"

  role_name = "${local.name}-${local.env}-external-secrets"

  role_policy_arns = {
    policy = aws_iam_policy.external_secrets.arn
  }

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:external-secrets"]
    }
  }

  tags = local.common_tags
}

resource "aws_iam_policy" "external_secrets" {
  name        = "${local.name}-${local.env}-external-secrets"
  description = "IAM policy for External Secrets to access Secrets Manager"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret"
        ]
        Resource = "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${local.name}-${local.env}-*"
      }
    ]
  })
}

# Create ClusterIssuer for Let's Encrypt
resource "kubernetes_manifest" "letsencrypt_issuer" {
  depends_on = [helm_release.cert_manager]
  
  manifest = {
    apiVersion = "cert-manager.io/v1"
    kind       = "ClusterIssuer"
    metadata = {
      name = "letsencrypt-prod"
    }
    spec = {
      acme = {
        server = "https://acme-v02.api.letsencrypt.org/directory"
        email  = var.alert_email
        privateKeySecretRef = {
          name = "letsencrypt-prod"
        }
        solvers = [{
          dns01 = {
            route53 = {
              region = var.aws_region
            }
          }
        }]
      }
    }
  }
}