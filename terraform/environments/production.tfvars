# Production environment configuration
environment = "production"
aws_region  = "us-east-1"

# VPC Configuration
vpc_cidr              = "10.0.0.0/16"
availability_zones    = ["us-east-1a", "us-east-1b", "us-east-1c"]
private_subnet_cidrs  = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
public_subnet_cidrs   = ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"]
database_subnet_cidrs = ["10.0.201.0/24", "10.0.202.0/24", "10.0.203.0/24"]

# EKS Configuration
kubernetes_version      = "1.28"
eks_node_instance_types = ["m6i.xlarge", "m6i.2xlarge"]
eks_node_min_size      = 5
eks_node_max_size      = 50
eks_node_desired_size  = 10
eks_capacity_type      = "ON_DEMAND"

# RDS Configuration
rds_instance_class          = "db.r6g.xlarge"
rds_allocated_storage       = 500
rds_max_allocated_storage   = 2000
rds_backup_retention_period = 30

# ElastiCache Configuration
redis_node_type               = "cache.r6g.xlarge"
redis_num_node_groups        = 3
redis_replicas_per_node_group = 2

# Monitoring
enable_monitoring = true

# Cost optimization
enable_spot_instances = true
enable_auto_scaling   = true

# Disaster recovery
enable_cross_region_backup = true
backup_region             = "us-west-2"