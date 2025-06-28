terraform {
  required_version = ">= 1.5.0"
  
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.23"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.11"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.5"
    }
  }
  
  backend "s3" {
    bucket         = "pup-ai-terraform-state"
    key            = "pup-ai/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "pup-ai-terraform-locks"
  }
}

# Data sources
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# Local variables
locals {
  name = var.app_name
  env  = var.environment
  
  common_tags = {
    Application = var.app_name
    Environment = var.environment
    ManagedBy   = "terraform"
    Version     = var.app_version
  }
  
  k8s_namespace = "pup-ai"
}

# VPC Module
module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
  version = "5.1.2"

  name = "${local.name}-${local.env}-vpc"
  cidr = var.vpc_cidr

  azs              = var.availability_zones
  private_subnets  = var.private_subnet_cidrs
  public_subnets   = var.public_subnet_cidrs
  database_subnets = var.database_subnet_cidrs

  enable_nat_gateway   = true
  single_nat_gateway   = var.environment == "dev"
  enable_dns_hostnames = true
  enable_dns_support   = true

  # VPC flow logs
  enable_flow_log                      = true
  create_flow_log_cloudwatch_iam_role  = true
  create_flow_log_cloudwatch_log_group = true

  # Kubernetes tags
  public_subnet_tags = {
    "kubernetes.io/role/elb"                    = 1
    "kubernetes.io/cluster/${local.name}-${local.env}" = "shared"
  }

  private_subnet_tags = {
    "kubernetes.io/role/internal-elb"           = 1
    "kubernetes.io/cluster/${local.name}-${local.env}" = "shared"
  }

  tags = local.common_tags
}

# EKS Module
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "19.16.0"

  cluster_name    = "${local.name}-${local.env}"
  cluster_version = var.kubernetes_version

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  # OIDC Provider
  enable_irsa = true

  # Cluster access
  cluster_endpoint_public_access  = true
  cluster_endpoint_private_access = true
  cluster_endpoint_public_access_cidrs = var.allowed_cidr_blocks

  # Encryption
  kms_key_id = aws_kms_key.eks.arn

  # Logging
  cluster_enabled_log_types = ["api", "audit", "authenticator", "controllerManager", "scheduler"]

  # Node groups
  eks_managed_node_groups = {
    general = {
      name            = "${local.name}-${local.env}-general"
      use_name_prefix = true

      subnet_ids = module.vpc.private_subnets

      min_size     = var.eks_node_min_size
      max_size     = var.eks_node_max_size
      desired_size = var.eks_node_desired_size

      instance_types = var.eks_node_instance_types
      capacity_type  = var.eks_capacity_type

      # Launch template
      create_launch_template = true
      launch_template_name   = ""

      disk_size = 100
      disk_type = "gp3"
      disk_throughput = 125
      disk_iops = 3000

      # Security
      create_security_group = true
      security_group_rules = {
        ingress_self_all = {
          description = "Node to node all ports/protocols"
          protocol    = "-1"
          from_port   = 0
          to_port     = 0
          type        = "ingress"
          self        = true
        }
        egress_all = {
          description      = "Node all egress"
          protocol         = "-1"
          from_port        = 0
          to_port          = 0
          type             = "egress"
          cidr_blocks      = ["0.0.0.0/0"]
          ipv6_cidr_blocks = ["::/0"]
        }
      }

      # IAM
      create_iam_instance_profile = true
      iam_role_name              = ""
      iam_role_use_name_prefix   = true
      iam_role_additional_policies = {
        AmazonSSMManagedInstanceCore = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
        CloudWatchAgentServerPolicy  = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
      }

      # User data
      enable_bootstrap_user_data = true
      pre_bootstrap_user_data = <<-EOT
        #!/bin/bash
        /usr/bin/imds-v2-only
      EOT

      # Metadata options
      metadata_options = {
        http_endpoint               = "enabled"
        http_tokens                 = "required"
        http_put_response_hop_limit = 2
        instance_metadata_tags      = "disabled"
      }

      # Labels
      labels = {
        Environment = var.environment
        NodeGroup   = "general"
      }

      # Taints
      taints = []

      tags = merge(local.common_tags, {
        NodeGroup = "general"
      })
    }

    spot = {
      name            = "${local.name}-${local.env}-spot"
      use_name_prefix = true

      subnet_ids = module.vpc.private_subnets

      min_size     = 0
      max_size     = 10
      desired_size = 2

      instance_types = ["t3.large", "t3a.large", "t3.xlarge", "t3a.xlarge"]
      capacity_type  = "SPOT"

      # Spot specific
      instance_market_options = {
        market_type = "spot"
        spot_options = {
          max_price = "0.5"
        }
      }

      labels = {
        Environment  = var.environment
        NodeGroup    = "spot"
        CapacityType = "spot"
      }

      taints = [{
        key    = "spot"
        value  = "true"
        effect = "NoSchedule"
      }]

      tags = merge(local.common_tags, {
        NodeGroup = "spot"
      })
    }
  }

  # Auth
  manage_aws_auth_configmap = true
  aws_auth_roles = var.eks_auth_roles
  aws_auth_users = var.eks_auth_users

  tags = local.common_tags
}

# KMS key for EKS encryption
resource "aws_kms_key" "eks" {
  description             = "EKS Secret Encryption Key for ${local.name}-${local.env}"
  deletion_window_in_days = 10
  enable_key_rotation     = true

  tags = local.common_tags
}

resource "aws_kms_alias" "eks" {
  name          = "alias/${local.name}-${local.env}-eks"
  target_key_id = aws_kms_key.eks.key_id
}

# RDS PostgreSQL
module "rds" {
  source  = "terraform-aws-modules/rds/aws"
  version = "6.1.1"

  identifier = "${local.name}-${local.env}-postgres"

  # Engine
  engine               = "postgres"
  engine_version       = var.rds_engine_version
  family               = var.rds_family
  major_engine_version = var.rds_major_engine_version
  instance_class       = var.rds_instance_class

  # Storage
  allocated_storage     = var.rds_allocated_storage
  max_allocated_storage = var.rds_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id           = aws_kms_key.rds.arn

  # Database
  db_name  = var.rds_database_name
  username = var.rds_username
  port     = 5432

  # Multi-AZ
  multi_az = var.environment == "production"

  # Networking
  db_subnet_group_name   = module.vpc.database_subnet_group_name
  vpc_security_group_ids = [aws_security_group.rds.id]

  # Backup
  backup_retention_period = var.rds_backup_retention_period
  backup_window          = var.rds_backup_window
  maintenance_window     = var.rds_maintenance_window
  skip_final_snapshot    = var.environment != "production"
  deletion_protection    = var.environment == "production"

  # Performance Insights
  performance_insights_enabled          = true
  performance_insights_retention_period = 7
  performance_insights_kms_key_id      = aws_kms_key.rds.arn

  # Monitoring
  enabled_cloudwatch_logs_exports = ["postgresql"]
  create_cloudwatch_log_group     = true
  monitoring_interval             = 60
  monitoring_role_arn            = aws_iam_role.rds_monitoring.arn

  # Parameters
  parameters = [
    {
      name  = "shared_preload_libraries"
      value = "pg_stat_statements,pgaudit,pgvector"
    },
    {
      name  = "log_statement"
      value = "all"
    },
    {
      name  = "log_min_duration_statement"
      value = "1000" # Log queries taking more than 1 second
    }
  ]

  tags = local.common_tags
}

# KMS key for RDS encryption
resource "aws_kms_key" "rds" {
  description             = "RDS Encryption Key for ${local.name}-${local.env}"
  deletion_window_in_days = 10
  enable_key_rotation     = true

  tags = local.common_tags
}

resource "aws_kms_alias" "rds" {
  name          = "alias/${local.name}-${local.env}-rds"
  target_key_id = aws_kms_key.rds.key_id
}

# RDS monitoring role
resource "aws_iam_role" "rds_monitoring" {
  name = "${local.name}-${local.env}-rds-monitoring"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "monitoring.rds.amazonaws.com"
      }
    }]
  })

  managed_policy_arns = ["arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"]

  tags = local.common_tags
}

# Security group for RDS
resource "aws_security_group" "rds" {
  name_prefix = "${local.name}-${local.env}-rds-"
  description = "Security group for RDS PostgreSQL"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description     = "PostgreSQL from EKS"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "${local.name}-${local.env}-rds"
  })
}

# ElastiCache Redis
module "elasticache" {
  source  = "terraform-aws-modules/elasticache/aws"
  version = "1.0.0"

  cluster_id               = "${local.name}-${local.env}-redis"
  create_cluster           = true
  create_replication_group = var.environment == "production"

  engine_version = var.redis_engine_version
  node_type      = var.redis_node_type
  
  # For production, use replication group
  replication_group_id = var.environment == "production" ? "${local.name}-${local.env}-redis" : null
  num_cache_nodes      = var.environment == "production" ? null : 1
  num_node_groups      = var.environment == "production" ? var.redis_num_node_groups : null
  replicas_per_node_group = var.environment == "production" ? var.redis_replicas_per_node_group : null

  # Networking
  subnet_ids = module.vpc.private_subnets
  security_group_ids = [aws_security_group.redis.id]

  # Parameters
  parameter = [
    {
      name  = "maxmemory-policy"
      value = "allkeys-lru"
    }
  ]

  # Maintenance
  maintenance_window = var.redis_maintenance_window
  
  # Encryption
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  tags = local.common_tags
}

# Security group for Redis
resource "aws_security_group" "redis" {
  name_prefix = "${local.name}-${local.env}-redis-"
  description = "Security group for ElastiCache Redis"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description     = "Redis from EKS"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "${local.name}-${local.env}-redis"
  })
}

# S3 bucket for logs
resource "aws_s3_bucket" "logs" {
  bucket = "${local.name}-${local.env}-logs-${data.aws_caller_identity.current.account_id}"

  tags = local.common_tags
}

resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.s3.arn
    }
  }
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket = aws_s3_bucket.logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    id     = "expire-old-logs"
    status = "Enabled"

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 90
      storage_class = "GLACIER"
    }

    expiration {
      days = 365
    }
  }
}

# KMS key for S3 encryption
resource "aws_kms_key" "s3" {
  description             = "S3 Encryption Key for ${local.name}-${local.env}"
  deletion_window_in_days = 10
  enable_key_rotation     = true

  tags = local.common_tags
}

resource "aws_kms_alias" "s3" {
  name          = "alias/${local.name}-${local.env}-s3"
  target_key_id = aws_kms_key.s3.key_id
}

# ECR repository
resource "aws_ecr_repository" "app" {
  name                 = "${local.name}-${local.env}"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key        = aws_kms_key.ecr.arn
  }

  tags = local.common_tags
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 10 production images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["v"]
          countType     = "imageCountMoreThan"
          countNumber   = 10
        }
        action = {
          type = "expire"
        }
      },
      {
        rulePriority = 2
        description  = "Expire untagged images after 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

# KMS key for ECR encryption
resource "aws_kms_key" "ecr" {
  description             = "ECR Encryption Key for ${local.name}-${local.env}"
  deletion_window_in_days = 10
  enable_key_rotation     = true

  tags = local.common_tags
}

resource "aws_kms_alias" "ecr" {
  name          = "alias/${local.name}-${local.env}-ecr"
  target_key_id = aws_kms_key.ecr.key_id
}

# Outputs
output "vpc_id" {
  description = "VPC ID"
  value       = module.vpc.vpc_id
}

output "eks_cluster_endpoint" {
  description = "EKS cluster endpoint"
  value       = module.eks.cluster_endpoint
}

output "eks_cluster_name" {
  description = "EKS cluster name"
  value       = module.eks.cluster_name
}

output "rds_endpoint" {
  description = "RDS endpoint"
  value       = module.rds.db_instance_endpoint
  sensitive   = true
}

output "redis_endpoint" {
  description = "Redis endpoint"
  value       = var.environment == "production" ? module.elasticache.primary_endpoint : module.elasticache.cluster_address
  sensitive   = true
}

output "ecr_repository_url" {
  description = "ECR repository URL"
  value       = aws_ecr_repository.app.repository_url
}