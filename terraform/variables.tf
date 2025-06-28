# General variables
variable "app_name" {
  description = "Application name"
  type        = string
  default     = "pup-ai"
}

variable "app_version" {
  description = "Application version"
  type        = string
  default     = "v2.0.0"
}

variable "environment" {
  description = "Environment name"
  type        = string
  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "Environment must be dev, staging, or production"
  }
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

# VPC variables
variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "Availability zones"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b", "us-east-1c"]
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for private subnets"
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for public subnets"
  type        = list(string)
  default     = ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"]
}

variable "database_subnet_cidrs" {
  description = "CIDR blocks for database subnets"
  type        = list(string)
  default     = ["10.0.201.0/24", "10.0.202.0/24", "10.0.203.0/24"]
}

# EKS variables
variable "kubernetes_version" {
  description = "Kubernetes version"
  type        = string
  default     = "1.28"
}

variable "eks_node_instance_types" {
  description = "Instance types for EKS nodes"
  type        = list(string)
  default     = ["t3.large", "t3.xlarge"]
}

variable "eks_node_min_size" {
  description = "Minimum number of nodes"
  type        = number
  default     = 3
}

variable "eks_node_max_size" {
  description = "Maximum number of nodes"
  type        = number
  default     = 20
}

variable "eks_node_desired_size" {
  description = "Desired number of nodes"
  type        = number
  default     = 3
}

variable "eks_capacity_type" {
  description = "EKS capacity type (ON_DEMAND or SPOT)"
  type        = string
  default     = "ON_DEMAND"
}

variable "allowed_cidr_blocks" {
  description = "CIDR blocks allowed to access EKS API"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "eks_auth_roles" {
  description = "Additional IAM roles to add to aws-auth configmap"
  type = list(object({
    rolearn  = string
    username = string
    groups   = list(string)
  }))
  default = []
}

variable "eks_auth_users" {
  description = "Additional IAM users to add to aws-auth configmap"
  type = list(object({
    userarn  = string
    username = string
    groups   = list(string)
  }))
  default = []
}

# RDS variables
variable "rds_engine_version" {
  description = "PostgreSQL engine version"
  type        = string
  default     = "15.4"
}

variable "rds_family" {
  description = "DB parameter group family"
  type        = string
  default     = "postgres15"
}

variable "rds_major_engine_version" {
  description = "Major engine version"
  type        = string
  default     = "15"
}

variable "rds_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.r6g.large"
}

variable "rds_allocated_storage" {
  description = "Allocated storage in GB"
  type        = number
  default     = 100
}

variable "rds_max_allocated_storage" {
  description = "Maximum allocated storage in GB"
  type        = number
  default     = 1000
}

variable "rds_database_name" {
  description = "Database name"
  type        = string
  default     = "pupai"
}

variable "rds_username" {
  description = "Database username"
  type        = string
  default     = "pupai_admin"
}

variable "rds_backup_retention_period" {
  description = "Backup retention period in days"
  type        = number
  default     = 30
}

variable "rds_backup_window" {
  description = "Backup window"
  type        = string
  default     = "03:00-04:00"
}

variable "rds_maintenance_window" {
  description = "Maintenance window"
  type        = string
  default     = "sun:04:00-sun:05:00"
}

# ElastiCache variables
variable "redis_engine_version" {
  description = "Redis engine version"
  type        = string
  default     = "7.0"
}

variable "redis_node_type" {
  description = "Redis node type"
  type        = string
  default     = "cache.r6g.large"
}

variable "redis_num_node_groups" {
  description = "Number of node groups (shards) for Redis cluster"
  type        = number
  default     = 3
}

variable "redis_replicas_per_node_group" {
  description = "Number of replica nodes in each node group"
  type        = number
  default     = 2
}

variable "redis_maintenance_window" {
  description = "Maintenance window for Redis"
  type        = string
  default     = "sun:05:00-sun:06:00"
}

# Application secrets (should be stored in AWS Secrets Manager)
variable "slack_bot_token" {
  description = "Slack bot token"
  type        = string
  sensitive   = true
}

variable "slack_app_token" {
  description = "Slack app token"
  type        = string
  sensitive   = true
}

variable "slack_signing_secret" {
  description = "Slack signing secret"
  type        = string
  sensitive   = true
}

variable "openai_api_key" {
  description = "OpenAI API key"
  type        = string
  sensitive   = true
}

# Monitoring and alerting
variable "enable_monitoring" {
  description = "Enable monitoring stack"
  type        = bool
  default     = true
}

variable "alert_email" {
  description = "Email address for alerts"
  type        = string
  default     = ""
}

variable "alert_slack_webhook" {
  description = "Slack webhook URL for alerts"
  type        = string
  default     = ""
  sensitive   = true
}

# Cost optimization
variable "enable_spot_instances" {
  description = "Enable spot instances for workers"
  type        = bool
  default     = true
}

variable "enable_auto_scaling" {
  description = "Enable auto-scaling for nodes"
  type        = bool
  default     = true
}

# Backup and disaster recovery
variable "enable_cross_region_backup" {
  description = "Enable cross-region backup"
  type        = bool
  default     = false
}

variable "backup_region" {
  description = "Region for cross-region backups"
  type        = string
  default     = "us-west-2"
}