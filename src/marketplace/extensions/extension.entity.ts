import {
  Column,
  CreateDateColumn,
  Entity,
  JoinTable,
  ManyToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm'
import { Category } from '../categories/category.entity'
import { ExtensionStatus } from './enums/extension-status.enum'

@Entity()
export class Extension {
  @PrimaryGeneratedColumn('increment')
  id!: number

  @Column({ type: 'varchar', unique: true })
  title!: string

  @Column({ type: 'text', nullable: true, default: null })
  description!: string | null

  @Column({ type: 'uuid', generated: 'uuid', unique: true })
  url: string

  @Column('varchar')
  version: string

  @Column({
    type: 'enum',
    enum: ExtensionStatus,
    default: ExtensionStatus.PENDING,
  })
  status: string

  @CreateDateColumn()
  createdAt: Date

  @UpdateDateColumn()
  updatedAt: Date

  @ManyToMany(() => Category)
  @JoinTable()
  categories: Category[]
}
